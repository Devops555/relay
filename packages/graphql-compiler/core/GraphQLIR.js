/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 * @format
 */

'use strict';

import type {
  GraphQLCompositeType,
  GraphQLOutputType,
  GraphQLInputType,
  GraphQLLeafType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLUnionType,
} from 'graphql';

type Metadata = ?{[key: string]: mixed};

export type Argument = {|
  +kind: 'Argument',
  +metadata: Metadata,
  +name: string,
  +type: ?GraphQLInputType,
  +value: ArgumentValue,
|};

export type ArgumentDefinition =
  | LocalArgumentDefinition
  | RootArgumentDefinition;

export type ArgumentValue = ListValue | Literal | ObjectValue | Variable;

export type Condition = {|
  +kind: 'Condition',
  +condition: Literal | Variable,
  +metadata: Metadata,
  +passingValue: boolean,
  +selections: $ReadOnlyArray<Selection>,
|};

export type Directive = {|
  +args: $ReadOnlyArray<Argument>,
  +kind: 'Directive',
  +metadata: Metadata,
  +name: string,
|};

export type Field = LinkedField | ScalarField | MatchField;

export type Fragment = {|
  +argumentDefinitions: $ReadOnlyArray<ArgumentDefinition>,
  +directives: $ReadOnlyArray<Directive>,
  +kind: 'Fragment',
  +metadata: Metadata,
  +name: string,
  +selections: $ReadOnlyArray<Selection>,
  +type: GraphQLCompositeType,
|};

export type FragmentSpread = {|
  +args: $ReadOnlyArray<Argument>,
  +directives: $ReadOnlyArray<Directive>,
  +kind: 'FragmentSpread',
  +metadata: Metadata,
  +name: string,
|};

export type IR =
  | Argument
  | Condition
  | Directive
  | Fragment
  | FragmentSpread
  | InlineFragment
  | LinkedField
  | ListValue
  | Literal
  | LocalArgumentDefinition
  | MatchField
  | MatchFragmentSpread
  | ObjectFieldValue
  | ObjectValue
  | Request
  | Root
  | RootArgumentDefinition
  | ScalarField
  | Variable;

export type RootArgumentDefinition = {|
  +kind: 'RootArgumentDefinition',
  +metadata: Metadata,
  +name: string,
  +type: GraphQLInputType,
|};

export type InlineFragment = {|
  +directives: $ReadOnlyArray<Directive>,
  +kind: 'InlineFragment',
  +metadata: Metadata,
  +selections: $ReadOnlyArray<Selection>,
  +typeCondition: GraphQLCompositeType,
|};

export type Handle = {|
  +name: string,
  +key: string,
  +filters: ?$ReadOnlyArray<string>,
|};

export type LinkedField = {|
  +alias: ?string,
  +args: $ReadOnlyArray<Argument>,
  +directives: $ReadOnlyArray<Directive>,
  +handles: ?$ReadOnlyArray<Handle>,
  +kind: 'LinkedField',
  +metadata: Metadata,
  +name: string,
  +selections: $ReadOnlyArray<Selection>,
  +type: GraphQLOutputType,
|};

export type ListValue = {|
  +kind: 'ListValue',
  +items: $ReadOnlyArray<ArgumentValue>,
  +metadata: Metadata,
|};

export type Literal = {|
  +kind: 'Literal',
  +metadata: Metadata,
  +value: mixed,
|};

export type LocalArgumentDefinition = {|
  +defaultValue: mixed,
  +kind: 'LocalArgumentDefinition',
  +metadata: Metadata,
  +name: string,
  +type: GraphQLInputType,
|};

export type MatchFragmentSpread = {|
  +kind: 'MatchFragmentSpread',
  +type: ?GraphQLCompositeType,
  +module: string,
  +args: $ReadOnlyArray<Argument>,
  +directives: $ReadOnlyArray<Directive>,
  +metadata: Metadata,
  +name: string,
|};

export type MatchField = {|
  +alias: ?string,
  +args: $ReadOnlyArray<Argument>,
  +directives: $ReadOnlyArray<Directive>,
  +handles: ?$ReadOnlyArray<Handle>,
  +kind: 'MatchField',
  +metadata: Metadata,
  +name: string,
  +type: GraphQLUnionType | GraphQLNonNull<GraphQLUnionType>,
  +selections: $ReadOnlyArray<Selection>,
|};

export type Node =
  | Condition
  | Fragment
  | InlineFragment
  | LinkedField
  | MatchField
  | Root;

export type ObjectFieldValue = {|
  +kind: 'ObjectFieldValue',
  +metadata: Metadata,
  +name: string,
  +value: ArgumentValue,
|};

export type ObjectValue = {|
  +kind: 'ObjectValue',
  +fields: $ReadOnlyArray<ObjectFieldValue>,
  +metadata: Metadata,
|};

export type Request = {|
  +kind: 'Request',
  +fragment: Fragment,
  +id: ?string,
  +metadata: Metadata,
  +name: string,
  +root: Root,
  +text: ?string,
|};

export type Root = {|
  +argumentDefinitions: $ReadOnlyArray<LocalArgumentDefinition>,
  +directives: $ReadOnlyArray<Directive>,
  +kind: 'Root',
  +metadata: Metadata,
  +name: string,
  +operation: 'query' | 'mutation' | 'subscription',
  +selections: $ReadOnlyArray<Selection>,
  +type: GraphQLCompositeType,
|};

export type ScalarFieldType =
  | GraphQLLeafType
  | GraphQLList<ScalarFieldType>
  | GraphQLNonNull<GraphQLLeafType | GraphQLList<ScalarFieldType>>;

export type ScalarField = {|
  +alias: ?string,
  +args: $ReadOnlyArray<Argument>,
  +directives: $ReadOnlyArray<Directive>,
  +handles: ?$ReadOnlyArray<Handle>,
  +kind: 'ScalarField',
  +metadata: Metadata,
  +name: string,
  +type: ScalarFieldType,
|};

export type Selection =
  | Condition
  | FragmentSpread
  | InlineFragment
  | LinkedField
  | MatchField
  | MatchFragmentSpread
  | ScalarField;

export type Variable = {|
  +kind: 'Variable',
  +metadata: Metadata,
  +variableName: string,
  +type: ?GraphQLInputType,
|};
