/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

use std::{collections::HashMap, path::PathBuf};

use crate::{
    lsp_runtime_error::{LSPRuntimeError, LSPRuntimeResult},
    type_path::{TypePath, TypePathItem},
};
use common::{SourceLocationKey, Span};
use graphql_syntax::{
    parse_executable, Argument, Directive, ExecutableDefinition, ExecutableDocument,
    FragmentSpread, GraphQLSource, InlineFragment, LinkedField, List, OperationDefinition,
    ScalarField, Selection,
};
use interner::StringKey;
use log::info;
use lsp_types::{Position, TextDocumentPositionParams, Url};
use relay_compiler::{compiler_state::SourceSet, FileCategorizer, FileGroup};
#[derive(Debug, Clone, PartialEq)]
pub enum NodeKind {
    OperationDefinition,
    FragmentDefinition(StringKey),
    FieldName,
    FieldArgument(StringKey, StringKey),
    FragmentSpread(StringKey),
    Variable(String),
    Directive(StringKey, Option<StringKey>),
}

#[derive(Debug)]
pub struct NodeResolutionInfo {
    /// The type of the leaf node on which the information request was made
    pub kind: NodeKind,
    /// A list of type metadata that we can use to resolve the leaf
    /// type the request is being made against
    pub type_path: TypePath,
    /// The project the request belongs to
    pub project_name: StringKey,
}

impl NodeResolutionInfo {
    fn new(project_name: StringKey, kind: NodeKind) -> Self {
        Self {
            kind,
            type_path: Default::default(),
            project_name,
        }
    }
}

/// Return a `GraphQLSource` for a given position, if the position
/// falls within a graphql literal.
fn get_graphql_source<'a>(
    text_document_position: &'a TextDocumentPositionParams,
    graphql_source_cache: &'a HashMap<Url, Vec<GraphQLSource>>,
) -> LSPRuntimeResult<&'a GraphQLSource> {
    let TextDocumentPositionParams {
        text_document,
        position,
    } = text_document_position;
    let url = &text_document.uri;

    let graphql_sources = graphql_source_cache.get(url).ok_or_else(|| {
        LSPRuntimeError::UnexpectedError(format!("{} not found in source cache", url))
    })?;

    // We have GraphQL documents, now check if the position
    // falls within the range of one of these documents.
    let graphql_source = graphql_sources
        .iter()
        .find(|graphql_source| {
            let range = graphql_source.to_range();
            position >= &range.start && position <= &range.end
        })
        .ok_or_else(|| LSPRuntimeError::ExpectedError)?;

    Ok(graphql_source)
}

/// Return a parsed executable document for this LSP request, only if the request occurs
/// within a GraphQL document. Otherwise return `None`
pub fn extract_executable_document_from_text(
    text_document_position: TextDocumentPositionParams,
    graphql_source_cache: &HashMap<Url, Vec<GraphQLSource>>,
    file_categorizer: &FileCategorizer,
    root_dir: &PathBuf,
) -> LSPRuntimeResult<(ExecutableDocument, Span, StringKey)> {
    let graphql_source = get_graphql_source(&text_document_position, graphql_source_cache)?;
    let url = &text_document_position.text_document.uri;
    let position = text_document_position.position;
    let absolute_file_path = PathBuf::from(url.path());
    let file_path = absolute_file_path.strip_prefix(root_dir).map_err(|_e| {
        LSPRuntimeError::UnexpectedError(format!(
            "Failed to strip prefix {:?} from {:?}",
            root_dir, absolute_file_path
        ))
    })?;

    let project_name =
        if let FileGroup::Source { source_set } = file_categorizer.categorize(&file_path.into()) {
            match source_set {
                SourceSet::SourceSetName(source) => source,
                SourceSet::SourceSetNames(sources) => sources[0],
            }
        } else {
            return Err(LSPRuntimeError::UnexpectedError(format!(
                "File path {:?} is not a source set",
                file_path
            )));
        };

    let document = parse_executable(
        &graphql_source.text,
        SourceLocationKey::standalone(&url.to_string()),
    )
    .map_err(|e| {
        LSPRuntimeError::UnexpectedError(format!(
            "Failed to parse document {:?}. Errors {:?}",
            file_path, e
        ))
    })?;

    // Now we need to take the `Position` and map that to an offset relative
    // to this GraphQL document, as the `Span`s in the document are relative.
    info!("Successfully parsed the definitions for a target GraphQL source");
    // Map the position to a zero-length span, relative to this GraphQL source.
    let position_span = position_to_span(position, &graphql_source).ok_or_else(|| {
        LSPRuntimeError::UnexpectedError("Failed to map positions to spans".to_string())
    })?;

    // Now we need to walk the Document, tracking our path along the way, until
    // we find the position within the document. Note that the GraphQLSource will
    // already be updated *with the characters that triggered the completion request*
    // since the change event fires before completion.
    info!("position_span: {:?}", position_span);

    Ok((document, position_span, project_name))
}

/// Maps the LSP `Position` type back to a relative span, so we can find out which syntax node(s)
/// this completion request came from
fn position_to_span(position: Position, source: &GraphQLSource) -> Option<Span> {
    let mut index_of_last_line = 0;
    let mut line_index = source.line_index as u64;

    let mut chars = source.text.chars().enumerate().peekable();

    while let Some((index, chr)) = chars.next() {
        let is_newline = match chr {
            // Line terminators: https://www.ecma-international.org/ecma-262/#sec-line-terminators
            '\u{000A}' | '\u{000D}' | '\u{2028}' | '\u{2029}' => {
                !matches!((chr, chars.peek()), ('\u{000D}', Some((_, '\u{000D}'))))
            }
            _ => false,
        };

        if is_newline {
            line_index += 1;
            index_of_last_line = index as u64;
        }

        if line_index == position.line {
            let start_offset = (index_of_last_line + position.character) as u32;
            return Some(Span::new(start_offset, start_offset));
        }
    }
    None
}

#[derive(Debug)]
pub(crate) struct SameLineOffset {
    character_offset: u64,
}

#[derive(Debug)]
pub(crate) struct DifferentLineOffset {
    line_offset: u64,
    character: u64,
}

/// Represents the offset from a given position to another position.
/// The SameLineOffset variant represents moving to a later character
/// position on the same line. The NewPositionOffset represents moving to
/// a later line, and an arbitrary character position.
#[derive(Debug)]
pub(crate) enum PositionOffset {
    SameLineOffset(SameLineOffset),
    DifferentLineOffset(DifferentLineOffset),
}

impl std::ops::Add<PositionOffset> for Position {
    type Output = Self;

    fn add(self, offset: PositionOffset) -> Self::Output {
        match offset {
            PositionOffset::SameLineOffset(SameLineOffset { character_offset }) => Position {
                line: self.line,
                character: self.character + character_offset,
            },
            PositionOffset::DifferentLineOffset(DifferentLineOffset {
                line_offset,
                character,
            }) => Position {
                line: self.line + line_offset,
                character,
            },
        }
    }
}

#[derive(Debug)]
pub(crate) struct RangeOffset {
    pub start: PositionOffset,
    pub end: PositionOffset,
}

/// Returns a RangeOffset that represents the offset from the start
/// of the source to the contents of the span.
pub(crate) fn span_to_range_offset(span: Span, text: &str) -> Option<RangeOffset> {
    if text.len() < span.end as usize {
        return None;
    }

    let mut start_position_offset = None;
    let mut end_position_offset = None;
    let Span { start, end } = span;
    let span_start = start as u64;
    let span_end = end as u64;
    let mut characters_iterated: u64 = 0;

    // For each line, determine whether the start and end of the span
    // occur on that line.
    for (line_index, line) in text.lines().enumerate() {
        let line_length = line.len() as u64;
        if start_position_offset.is_none() && characters_iterated + line_length >= span_start {
            start_position_offset = Some(if line_index == 0 {
                PositionOffset::SameLineOffset(SameLineOffset {
                    character_offset: span_start,
                })
            } else {
                PositionOffset::DifferentLineOffset(DifferentLineOffset {
                    line_offset: line_index as u64,
                    character: span_start - characters_iterated,
                })
            });
        }
        if end_position_offset.is_none() && characters_iterated + line_length >= span_end {
            end_position_offset = Some(if line_index == 0 {
                PositionOffset::SameLineOffset(SameLineOffset {
                    character_offset: span_end,
                })
            } else {
                PositionOffset::DifferentLineOffset(DifferentLineOffset {
                    line_offset: line_index as u64,
                    character: span_end - characters_iterated,
                })
            });
            break;
        }
        characters_iterated += line_length;
        // we also need to advance characters_iterated by 1 to account for the line break
        characters_iterated += 1;
    }

    Some(RangeOffset {
        start: start_position_offset?,
        end: end_position_offset?,
    })
}

fn build_node_resolution_for_directive(
    directives: &[Directive],
    position_span: Span,
    project_name: StringKey,
) -> Option<NodeResolutionInfo> {
    let directive = directives
        .iter()
        .find(|directive| directive.span.contains(position_span))?;

    let arg_name_opt = if let Some(args) = &directive.arguments {
        args.items
            .iter()
            .find(|arg| arg.span.contains(position_span))
            .map(|arg| arg.name.value)
    } else {
        None
    };

    Some(NodeResolutionInfo {
        kind: NodeKind::Directive(directive.name.value, arg_name_opt),
        type_path: Default::default(),
        project_name,
    })
}

fn create_node_resolution_info(
    document: ExecutableDocument,
    position_span: Span,
    project_name: StringKey,
) -> LSPRuntimeResult<NodeResolutionInfo> {
    let definition = document
        .definitions
        .iter()
        .find(|definition| definition.location().contains(position_span))
        .ok_or(LSPRuntimeError::ExpectedError)?;

    match definition {
        ExecutableDefinition::Operation(operation) => {
            if operation.location.contains(position_span) {
                let mut node_resolution_info =
                    NodeResolutionInfo::new(project_name, NodeKind::OperationDefinition);
                let OperationDefinition {
                    selections,
                    variable_definitions,
                    ..
                } = operation;

                if let Some(variable_definitions) = variable_definitions {
                    if let Some(variable) = variable_definitions
                        .items
                        .iter()
                        .find(|var| var.span.contains(position_span))
                    {
                        node_resolution_info.kind = NodeKind::Variable(variable.type_.to_string());
                        return Ok(node_resolution_info);
                    }
                }

                let (_, kind) = operation.operation.clone().ok_or_else(|| {
                    LSPRuntimeError::UnexpectedError(
                        "Expected operation to exist, but it did not".to_string(),
                    )
                })?;
                node_resolution_info
                    .type_path
                    .add_type(TypePathItem::Operation(kind));

                build_node_resolution_info_from_selections(
                    selections,
                    position_span,
                    &mut node_resolution_info,
                );
                Ok(node_resolution_info)
            } else {
                Err(LSPRuntimeError::UnexpectedError(format!(
                    "Expected operation named {:?} to contain position {:?}, but it did not. Operation span {:?}",
                    operation.name, operation.location, position_span
                )))
            }
        }
        ExecutableDefinition::Fragment(fragment) => {
            if fragment.location.contains(position_span) {
                let mut node_resolution_info = NodeResolutionInfo::new(
                    project_name,
                    NodeKind::FragmentDefinition(fragment.name.value),
                );
                if let Some(node_resolution_info) = build_node_resolution_for_directive(
                    &fragment.directives,
                    position_span,
                    project_name,
                ) {
                    return Ok(node_resolution_info);
                }

                let type_name = fragment.type_condition.type_.value;
                node_resolution_info
                    .type_path
                    .add_type(TypePathItem::FragmentDefinition { type_name });
                build_node_resolution_info_from_selections(
                    &fragment.selections,
                    position_span,
                    &mut node_resolution_info,
                );
                Ok(node_resolution_info)
            } else {
                Err(LSPRuntimeError::UnexpectedError(format!(
                    "Expected fragment named {:?} to contain position {:?}, but it did not. Operation span {:?}",
                    fragment.name, fragment.location, position_span
                )))
            }
        }
    }
}

/// If position_span falls into one of the field arguments,
/// we need to display resolution info for this field
fn build_node_resolution_info_for_argument(
    field_name: StringKey,
    arguments: &Option<List<Argument>>,
    position_span: Span,
    node_resolution_info: &mut NodeResolutionInfo,
) -> Option<()> {
    if let Some(arguments) = &arguments {
        let argument = arguments
            .items
            .iter()
            .find(|item| item.span.contains(position_span))?;

        node_resolution_info.kind = NodeKind::FieldArgument(field_name, argument.name.value);

        Some(())
    } else {
        None
    }
}

fn build_node_resolution_info_from_selections(
    selections: &List<Selection>,
    position_span: Span,
    node_resolution_info: &mut NodeResolutionInfo,
) {
    if let Some(item) = selections
        .items
        .iter()
        .find(|item| item.span().contains(position_span))
    {
        if let Some(directive_resolution_info) = build_node_resolution_for_directive(
            item.directives(),
            position_span,
            node_resolution_info.project_name,
        ) {
            node_resolution_info.kind = directive_resolution_info.kind;
            return;
        }

        match item {
            Selection::LinkedField(node) => {
                node_resolution_info.kind = NodeKind::FieldName;
                let LinkedField {
                    name, selections, ..
                } = node;
                if build_node_resolution_info_for_argument(
                    name.value,
                    &node.arguments,
                    position_span,
                    node_resolution_info,
                )
                .is_none()
                {
                    node_resolution_info
                        .type_path
                        .add_type(TypePathItem::LinkedField { name: name.value });
                    build_node_resolution_info_from_selections(
                        selections,
                        position_span,
                        node_resolution_info,
                    );
                }
            }
            Selection::FragmentSpread(spread) => {
                let FragmentSpread { name, .. } = spread;
                if name.span.contains(position_span) {
                    node_resolution_info.kind = NodeKind::FragmentSpread(name.value);
                }
            }
            Selection::InlineFragment(node) => {
                let InlineFragment {
                    selections,
                    type_condition,
                    ..
                } = node;
                if let Some(type_condition) = type_condition {
                    let type_name = type_condition.type_.value;
                    node_resolution_info
                        .type_path
                        .add_type(TypePathItem::InlineFragment { type_name });
                    build_node_resolution_info_from_selections(
                        selections,
                        position_span,
                        node_resolution_info,
                    )
                }
            }
            Selection::ScalarField(node) => {
                let ScalarField { name, .. } = node;

                if build_node_resolution_info_for_argument(
                    name.value,
                    &node.arguments,
                    position_span,
                    node_resolution_info,
                )
                .is_none()
                {
                    node_resolution_info.kind = NodeKind::FieldName;
                    node_resolution_info
                        .type_path
                        .add_type(TypePathItem::ScalarField { name: name.value });
                }
            }
        }
    }
}

/// Return a `NodeResolutionInfo` for this request if the request occurred
/// within a GraphQL document.
pub fn get_node_resolution_info(
    text_document_position: TextDocumentPositionParams,
    graphql_source_cache: &HashMap<Url, Vec<GraphQLSource>>,
    file_categorizer: &FileCategorizer,
    root_dir: &PathBuf,
) -> LSPRuntimeResult<NodeResolutionInfo> {
    let (document, position_span, project_name) = extract_executable_document_from_text(
        text_document_position,
        graphql_source_cache,
        file_categorizer,
        root_dir,
    )?;

    create_node_resolution_info(document, position_span, project_name)
}

#[cfg(test)]
mod test {
    use super::create_node_resolution_info;
    use super::NodeKind;
    use common::{SourceLocationKey, Span};
    use graphql_syntax::parse_executable;
    use interner::Intern;
    use relay_test_schema::get_test_schema;

    #[test]
    fn create_node_resolution_info_test() {
        let document = parse_executable(
            r#"
            fragment User_data on User {
                name
                profile_picture {
                    uri
                }
            }
        "#,
            SourceLocationKey::Standalone {
                path: "/test/file".intern(),
            },
        )
        .unwrap();

        // Select the `id` field
        let position_span = Span {
            start: 117,
            end: 117,
        };

        let result = create_node_resolution_info(document, position_span, "test_project".intern());
        let node_resolution_info = result.unwrap();
        assert_eq!(node_resolution_info.kind, NodeKind::FieldName);
        assert_eq!(node_resolution_info.project_name.lookup(), "test_project");
        let schema = get_test_schema();
        let type_ref = node_resolution_info
            .type_path
            .resolve_current_type_reference(&schema)
            .unwrap();
        assert_eq!(schema.get_type_string(&type_ref), "String".to_string());
    }

    #[test]
    fn create_node_resolution_info_test_position_outside() {
        let document = parse_executable(
            r#"
            fragment User_data on User {
                name
            }
        "#,
            SourceLocationKey::Standalone {
                path: "/test/file".intern(),
            },
        )
        .unwrap();
        // Position is outside of the document
        let position_span = Span { start: 86, end: 87 };
        let result = create_node_resolution_info(document, position_span, "test_project".intern());
        assert!(result.is_err());
    }
}
