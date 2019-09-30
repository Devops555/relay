/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 * @emails oncall+relay
 * @format
 */

'use strict';

const GraphQLCompilerContext = require('../../core/GraphQLCompilerContext');
const GraphQLIRPrinter = require('../../core/GraphQLIRPrinter');
const RelayMatchTransform = require('../RelayMatchTransform');
const RelayRelayDirectiveTransform = require('../RelayRelayDirectiveTransform');
const Schema = require('../../core/Schema');

const {transformASTSchema} = require('../../core/ASTConvert');
const {
  TestSchema,
  generateTestsFromFixtures,
  parseGraphQLText,
} = require('relay-test-utils-internal');

describe('RelayMatchTransform', () => {
  const extendedSchema = transformASTSchema(TestSchema, [
    RelayMatchTransform.SCHEMA_EXTENSION,
  ]);
  generateTestsFromFixtures(
    `${__dirname}/fixtures/relay-match-transform`,
    text => {
      const {definitions} = parseGraphQLText(extendedSchema, text);
      const compilerSchema = Schema.DEPRECATED__create(
        TestSchema,
        extendedSchema,
      );
      return new GraphQLCompilerContext(compilerSchema)
        .addAll(definitions)
        .applyTransforms([
          // Requires Relay directive transform first.
          RelayRelayDirectiveTransform.transform,
          RelayMatchTransform.transform,
        ])
        .documents()
        .map(doc => GraphQLIRPrinter.print(compilerSchema, doc))
        .join('\n');
    },
  );
});
