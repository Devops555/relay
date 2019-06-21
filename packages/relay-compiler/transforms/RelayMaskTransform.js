/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * All rights reserved.
 *
 * @flow
 * @format
 */

'use strict';

const CompilerContext = require('../core/GraphQLCompilerContext');
const IRTransformer = require('../core/GraphQLIRTransformer');

const invariant = require('invariant');
const joinArgumentDefinitions = require('../util/joinArgumentDefinitions');

const {createUserError} = require('../core/RelayCompilerError');

import type {
  Fragment,
  FragmentSpread,
  InlineFragment,
  ArgumentDefinition,
} from '../core/GraphQLIR';

type State = {
  reachableArguments: Array<{
    argDef: ArgumentDefinition,
    source: string /* fragment spread name */,
  }>,
};

/**
 * A transform that inlines fragment spreads with the @relay(mask: false)
 * directive.
 */
function relayMaskTransform(context: CompilerContext): CompilerContext {
  return IRTransformer.transform(
    context,
    {
      FragmentSpread: visitFragmentSpread,
      Fragment: visitFragment,
    },
    () => ({
      reachableArguments: [],
    }),
  );
}

function visitFragment(fragment: Fragment, state: State): Fragment {
  const result = this.traverse(fragment, state);
  if (state.reachableArguments.length === 0) {
    return result;
  }
  const schema = this.getContext().serverSchema;
  const joinedArgumentDefinitions = joinArgumentDefinitions(
    schema,
    fragment,
    state.reachableArguments,
  );
  return {
    ...result,
    argumentDefinitions: joinedArgumentDefinitions,
  };
}

function visitFragmentSpread(
  fragmentSpread: FragmentSpread,
  state: State,
): FragmentSpread {
  if (!isUnmaskedSpread(fragmentSpread)) {
    return fragmentSpread;
  }
  invariant(
    fragmentSpread.args.length === 0,
    'RelayMaskTransform: Cannot unmask fragment spread `%s` with ' +
      'arguments. Use the `ApplyFragmentArgumentTransform` before flattening',
    fragmentSpread.name,
  );
  const context = this.getContext();
  const fragment = context.getFragment(fragmentSpread.name);
  const result: InlineFragment = {
    kind: 'InlineFragment',
    directives: fragmentSpread.directives,
    loc: {kind: 'Derived', source: fragmentSpread.loc},
    metadata: fragmentSpread.metadata,
    selections: fragment.selections,
    typeCondition: fragment.type,
  };

  if (fragment.directives.length > 0) {
    throw new createUserError(
      'Cannot use @relay(mask: false) on fragment spreads for fragments ' +
        'with directives.',
      [fragmentSpread.loc, fragment.directives[0].loc],
    );
  }

  const localArgDef = fragment.argumentDefinitions.find(
    argDef => argDef.kind === 'LocalArgumentDefinition',
  );
  if (localArgDef != null) {
    throw createUserError(
      'RelayMaskTransform: Cannot use @relay(mask: false) on fragment spread ' +
        'because the fragment definition uses @argumentDefinitions.',
      [fragmentSpread.loc, localArgDef.loc],
    );
  }

  // Note: defer validating arguments to the containing fragment in order
  // to list all invalid variables/arguments instead of only one.
  for (const argDef of fragment.argumentDefinitions) {
    state.reachableArguments.push({
      argDef: argDef,
      source: fragmentSpread.name,
    });
  }
  return this.traverse(result, state);
}

/**
 * @private
 */
function isUnmaskedSpread(spread: FragmentSpread): boolean {
  return Boolean(spread.metadata && spread.metadata.mask === false);
}

module.exports = {
  transform: relayMaskTransform,
};
