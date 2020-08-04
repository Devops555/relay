/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

use common::{ConsoleLogger, SourceLocationKey};
use fixture_tests::Fixture;
use fnv::FnvHashMap;
use graphql_ir::{build, Program};
use graphql_syntax::parse_executable;
use graphql_transforms::{ConnectionInterface, FeatureFlags};
use interner::Intern;
use relay_compiler::apply_transforms;
use relay_typegen::{self, TypegenConfig};
use std::sync::Arc;
use test_schema::{get_test_schema, get_test_schema_with_extensions};

pub fn transform_fixture(fixture: &Fixture) -> Result<String, String> {
    let parts = fixture.content.split("%extensions%").collect::<Vec<_>>();
    let (source, schema) = match parts.as_slice() {
        [source, extensions] => (source, get_test_schema_with_extensions(extensions)),
        [source] => (source, get_test_schema()),
        _ => panic!(),
    };

    let source_location = SourceLocationKey::standalone(fixture.file_name);

    let mut sources = FnvHashMap::default();
    sources.insert(source_location, source);
    let ast = parse_executable(source, source_location).unwrap();
    let ir = build(&schema, &ast.definitions).unwrap();
    let program = Program::from_definitions(Arc::clone(&schema), ir);
    let programs = apply_transforms(
        "test".intern(),
        Arc::new(program),
        Default::default(),
        &ConnectionInterface::default(),
        &FeatureFlags::default(),
        Arc::new(ConsoleLogger),
    )
    .unwrap();

    let mut operations: Vec<_> = programs.typegen.operations().collect();
    operations.sort_by_key(|op| op.name.item);
    let operation_strings = operations.into_iter().map(|typegen_operation| {
        let normalization_operation = programs
            .normalization
            .operation(typegen_operation.name.item)
            .unwrap();
        relay_typegen::generate_operation_type(
            typegen_operation,
            normalization_operation,
            &schema,
            &TypegenConfig::default(),
        )
    });

    let mut fragments: Vec<_> = programs.typegen.fragments().collect();
    fragments.sort_by_key(|frag| frag.name.item);
    let fragment_strings = fragments.into_iter().map(|frag| {
        relay_typegen::generate_fragment_type(frag, &schema, &TypegenConfig::default())
    });

    let mut result: Vec<String> = operation_strings.collect();
    result.extend(fragment_strings);
    Ok(result
        .join("-------------------------------------------------------------------------------\n"))
}
