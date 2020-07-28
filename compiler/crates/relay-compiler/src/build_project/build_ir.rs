/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

use crate::config::ProjectConfig;
use crate::{compiler_state::SourceSetName, graphql_asts::GraphQLAsts};
use dependency_analyzer::{get_reachable_ast, get_reachable_ir, ReachableAst};
use fnv::{FnvHashMap, FnvHashSet};
use graphql_ir::ValidationError;
use graphql_syntax::ExecutableDefinition;
use graphql_text_printer::print_executable_definition_ast;
use interner::StringKey;
use md5::{Digest, Md5};
use schema::Schema;

pub struct BuildIRResult {
    pub ir: Vec<graphql_ir::ExecutableDefinition>,
    pub source_hashes: SourceHashes,
    pub base_fragment_names: FnvHashSet<StringKey>,
}

/// Map fragments and queries definition names to the md5 of they printed source
pub struct SourceHashes(FnvHashMap<StringKey, String>);

impl SourceHashes {
    pub fn from_definitions(definitions: &[ExecutableDefinition]) -> Self {
        let mut source_hashes = FnvHashMap::default();
        for ast in definitions {
            if let Some(name) = ast.name() {
                source_hashes.insert(name, md5(&print_executable_definition_ast(ast)));
            }
        }
        Self(source_hashes)
    }

    pub fn get(&self, k: &StringKey) -> Option<&String> {
        self.0.get(k)
    }
}

pub fn build_ir(
    project_config: &ProjectConfig,
    schema: &Schema,
    graphql_asts: &FnvHashMap<SourceSetName, GraphQLAsts>,
    is_incremental_build: bool,
) -> Result<BuildIRResult, Vec<ValidationError>> {
    let project_asts = graphql_asts
        .get(&project_config.name)
        .map(|asts| asts.asts.clone())
        .unwrap_or_default();
    let (base_project_asts, base_definition_names) = match project_config.base {
        Some(base_project_name) => {
            let base_project_asts = graphql_asts
                .get(&base_project_name)
                .map(|asts| asts.asts.clone())
                .unwrap_or_default();
            let base_definition_names = base_project_asts
                .iter()
                // TODO(T64459085): Figure out what to do about unnamed (anonymous) operations
                .filter_map(|definition| definition.name())
                .collect::<FnvHashSet<_>>();
            (base_project_asts, base_definition_names)
        }
        None => (Vec::new(), FnvHashSet::default()),
    };
    let ReachableAst {
        definitions: reachable_ast,
        base_fragment_names,
    } = get_reachable_ast(project_asts, base_project_asts).unwrap();

    let source_hashes = SourceHashes::from_definitions(&reachable_ast);
    let ir = graphql_ir::build(&schema, &reachable_ast)?;
    if is_incremental_build {
        let mut changed_names = graphql_asts
            .get(&project_config.name)
            .map(|asts| asts.changed_definition_names.clone())
            .unwrap_or_default();
        if let Some(base_project_name) = project_config.base {
            changed_names.extend(
                graphql_asts
                    .get(&base_project_name)
                    .map(|asts| asts.changed_definition_names.clone())
                    .unwrap_or_default(),
            );
        }
        let affected_ir = get_reachable_ir(ir, base_definition_names, changed_names);
        Ok(BuildIRResult {
            ir: affected_ir,
            base_fragment_names,
            source_hashes,
        })
    } else {
        Ok(BuildIRResult {
            ir,
            base_fragment_names,
            source_hashes,
        })
    }
}

fn md5(data: &str) -> String {
    let mut md5 = Md5::new();
    md5.input(data);
    hex::encode(md5.result())
}
