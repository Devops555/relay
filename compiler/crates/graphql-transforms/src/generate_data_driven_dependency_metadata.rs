/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

use super::match_::{get_normalization_operation_name, MATCH_CONSTANTS};
use common::{NamedItem, WithLocation};
use fnv::FnvHashMap;
use graphql_ir::{
    Argument, ConstantValue, Directive, FragmentDefinition, Program, Selection, Transformed,
    Transformer, Value,
};
use interner::{Intern, StringKey};
use lazy_static::lazy_static;
use schema::TypeReference;

lazy_static! {
    pub static ref DATA_DRIVEN_DEPENDENCY_METADATA_KEY: StringKey =
        "__dataDrivenDependencyMetadata".intern();
}

pub fn generate_data_driven_dependency_metadata(program: &Program) -> Program {
    let mut transformer = GenerateDataDrivenDependencyMetadata::new(program);
    transformer
        .transform_program(program)
        .replace_or_else(|| program.clone())
}

struct GenerateDataDrivenDependencyMetadata<'s> {
    pub program: &'s Program,
}

impl<'s> GenerateDataDrivenDependencyMetadata<'s> {
    fn new(program: &'s Program) -> Self {
        GenerateDataDrivenDependencyMetadata { program }
    }
}

#[derive(Debug, Copy, Clone)]
struct Branch {
    component: StringKey,
    fragment: StringKey,
}

type ModuleEntries = FnvHashMap<StringKey, ModuleEntry>;

#[derive(Debug)]
struct ModuleEntry {
    id: StringKey,
    branches: FnvHashMap<String, Branch>,
    plural: bool,
}

#[derive(Debug)]
struct ProcessingItem<'a> {
    plural: bool,
    parent_type: TypeReference,
    selections: &'a [Selection],
}

impl<'s> Transformer for GenerateDataDrivenDependencyMetadata<'s> {
    const NAME: &'static str = "GenerateDataDrivenDependencyMetadata";
    const VISIT_ARGUMENTS: bool = false;
    const VISIT_DIRECTIVES: bool = false;

    fn transform_fragment(
        &mut self,
        fragment: &FragmentDefinition,
    ) -> Transformed<FragmentDefinition> {
        let parent_type = TypeReference::Named(fragment.type_condition);
        let mut processing_queue: Vec<ProcessingItem<'_>> = vec![ProcessingItem {
            plural: false,
            parent_type,
            selections: &fragment.selections,
        }];
        let mut module_entries: ModuleEntries = Default::default();

        while !processing_queue.is_empty() {
            if let Some(processing_item) = processing_queue.pop() {
                for selection in processing_item.selections {
                    match selection {
                        Selection::ScalarField(_) | Selection::FragmentSpread(_) => {}
                        Selection::LinkedField(linked_filed) => {
                            let field_type = &self
                                .program
                                .schema
                                .field(linked_filed.definition.item)
                                .type_;
                            processing_queue.push(ProcessingItem {
                                plural: field_type.is_list(),
                                parent_type: field_type.clone(),
                                selections: &linked_filed.selections,
                            });
                        }
                        Selection::InlineFragment(inline_fragment) => {
                            let parent_type = match inline_fragment.type_condition {
                                Some(type_) => TypeReference::Named(type_),
                                None => processing_item.parent_type.clone(),
                            };
                            let module_directive = inline_fragment
                                .directives
                                .named(MATCH_CONSTANTS.custom_module_directive_name);
                            if let Some(module_directive) = module_directive {
                                let id = get_argument_value(
                                    &module_directive,
                                    MATCH_CONSTANTS.js_field_id_arg,
                                );
                                let component = get_argument_value(
                                    &module_directive,
                                    MATCH_CONSTANTS.js_field_module_arg,
                                );
                                let fragment_spread =
                                    inline_fragment.selections.iter().find(|item| match item {
                                        Selection::FragmentSpread(_) => true,
                                        _ => false,
                                    });
                                // This is expected to be a fragment spread
                                let fragment_name = match fragment_spread {
                                    Some(Selection::FragmentSpread(spread)) => spread.fragment.item,
                                    _ => panic!("Expected to have a fragment spread"),
                                };

                                let type_name = self.program.schema.get_type_string(&parent_type);
                                module_entries
                                    .entry(id)
                                    .and_modify(|module_entry| {
                                        module_entry.branches.insert(
                                            type_name.clone(),
                                            Branch {
                                                component,
                                                fragment: get_fragment_filename(fragment_name),
                                            },
                                        );
                                    })
                                    .or_insert(ModuleEntry {
                                        id,
                                        branches: {
                                            let mut map: FnvHashMap<String, Branch> =
                                                Default::default();
                                            map.insert(
                                                type_name.clone(),
                                                Branch {
                                                    component,
                                                    fragment: get_fragment_filename(fragment_name),
                                                },
                                            );
                                            map
                                        },
                                        plural: processing_item.plural,
                                    });
                            }
                            processing_queue.push(ProcessingItem {
                                plural: processing_item.plural,
                                parent_type,
                                selections: &inline_fragment.selections,
                            });
                        }
                        Selection::Condition(condition) => {
                            processing_queue.push(ProcessingItem {
                                plural: processing_item.plural,
                                parent_type: processing_item.parent_type.clone(),
                                selections: &condition.selections,
                            });
                        }
                    }
                }
            }
        }

        if !module_entries.is_empty() {
            let mut next_directives: Vec<Directive> =
                Vec::with_capacity(fragment.directives.len() + 1);
            next_directives.push(create_metadata_directive(module_entries));

            Transformed::Replace(FragmentDefinition {
                directives: next_directives,
                ..fragment.clone()
            })
        } else {
            Transformed::Keep
        }
    }
}

fn create_metadata_directive(module_entries: FnvHashMap<StringKey, ModuleEntry>) -> Directive {
    let mut arguments: Vec<Argument> = Vec::with_capacity(module_entries.len());
    for (key, module_entry) in module_entries {
        arguments.push(Argument {
            name: WithLocation::generated(key),
            value: WithLocation::generated(Value::Constant(ConstantValue::String(From::from(
                module_entry,
            )))),
        })
    }
    arguments.sort_unstable_by(|a, b| a.name.item.cmp(&b.name.item));

    Directive {
        name: WithLocation::generated(*DATA_DRIVEN_DEPENDENCY_METADATA_KEY),
        arguments,
    }
}

impl From<ModuleEntry> for StringKey {
    fn from(module_entry: ModuleEntry) -> Self {
        let mut serialized_branches: Vec<(String, String)> =
            Vec::with_capacity(module_entry.branches.len());
        for (id, branch) in module_entry.branches.iter() {
            serialized_branches.push((
                id.clone(),
                format!(
                    "\"{}\":{{\"component\":\"{}\",\"fragment\":\"{}\"}}",
                    id, branch.component, branch.fragment
                ),
            ));
        }

        serialized_branches.sort_unstable_by(|a, b| a.0.cmp(&b.0));

        format!(
            "{{\"branches\":{{{}}},\"plural\":{}}}",
            serialized_branches
                .into_iter()
                .map(|(_, value)| value)
                .collect::<Vec<String>>()
                .join(","),
            module_entry.plural
        )
        .intern()
    }
}

fn get_argument_value(directive: &Directive, argument_name: StringKey) -> StringKey {
    match directive.arguments.named(argument_name).unwrap().value.item {
        Value::Constant(ConstantValue::String(value)) => value,
        _ => panic!(
            "Expected to have a constant string value for argument {}.",
            argument_name
        ),
    }
}

fn get_fragment_filename(fragment_name: StringKey) -> StringKey {
    let mut fragment = String::new();
    get_normalization_operation_name(&mut fragment, fragment_name);
    format!("{}.graphql", fragment).intern()
}
