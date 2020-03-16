/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

use common::FileKey;
use fixture_tests::Fixture;
use fnv::FnvHashMap;
use graphql_ir::{build, FragmentDefinition, Program};
use graphql_syntax::parse;
use graphql_text_printer::print_full_operation;
use graphql_transforms::OSSConnectionInterface;
use relay_codegen::{print_fragment, print_request};
use relay_compiler::{apply_transforms, validate};
use test_schema::{test_schema, test_schema_with_extensions};

pub fn transform_fixture(fixture: &Fixture) -> Result<String, String> {
    let mut sources = FnvHashMap::default();
    sources.insert(FileKey::new(fixture.file_name), fixture.content);

    if fixture.content.find("%TODO%").is_some() {
        if fixture.content.find("expected-to-throw").is_some() {
            return Err("TODO".to_string());
        }
        return Ok("TODO".to_string());
    }

    let parts: Vec<_> = fixture.content.split("%extensions%").collect();
    let (base, schema) = match parts.as_slice() {
        [base, extensions] => (base, test_schema_with_extensions(extensions)),
        [base] => (base, test_schema()),
        _ => panic!("Invalid fixture input {}", fixture.content),
    };

    let ast = parse(base, FileKey::new(fixture.file_name)).unwrap();
    let ir = build(&schema, &ast.definitions).unwrap();
    let program = Program::from_definitions(&schema, ir);
    let connection_interface = OSSConnectionInterface::default();

    let validation_result = validate(&program, &connection_interface);
    match validation_result {
        Ok(_) => {}
        Err(errors) => {
            let mut errs = errors
                .into_iter()
                .map(|err| err.print(&sources))
                .collect::<Vec<_>>();
            errs.sort();
            return Err(errs.join("\n\n"));
        }
    }

    // TODO pass base fragment names
    let programs = apply_transforms(&program, &Default::default(), &connection_interface);

    let mut result = programs
        .normalization
        .operations()
        .map(|operation| {
            let name = operation.name.item;
            let print_operation_node = programs
                .operation_text
                .operation(name)
                .expect("a query text operation should be generated for this operation");
            let text = print_full_operation(&programs.operation_text, print_operation_node);

            let reader_operation = programs
                .reader
                .operation(name)
                .expect("a reader fragment should be generated for this operation");
            let operation_fragment = FragmentDefinition {
                name: reader_operation.name,
                variable_definitions: reader_operation.variable_definitions.clone(),
                selections: reader_operation.selections.clone(),
                used_global_variables: Default::default(),
                directives: reader_operation.directives.clone(),
                type_condition: reader_operation.type_,
            };
            format!(
                "{}\n\nQUERY:\n\n{}",
                print_request(&schema, operation, &operation_fragment),
                text
            )
        })
        .chain(
            programs
                .reader
                .fragments()
                .map(|fragment| print_fragment(&schema, fragment)),
        )
        .collect::<Vec<_>>();
    result.sort_unstable();
    Ok(result.join("\n\n"))
}
