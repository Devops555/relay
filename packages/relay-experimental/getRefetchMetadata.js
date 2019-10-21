/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+relay
 * @flow strict-local
 * @format
 */

'use strict';

const invariant = require('invariant');

import type {
  ConcreteRequest,
  ReaderFragment,
  ReaderRefetchMetadata,
} from 'relay-runtime';

function getRefetchMetadata(
  fragmentNode: ReaderFragment,
  componentDisplayName: string,
): {|
  refetchableRequest: ConcreteRequest,
  fragmentRefPathInResponse: $ReadOnlyArray<string | number>,
  refetchMetadata: ReaderRefetchMetadata,
|} {
  invariant(
    fragmentNode.metadata?.plural !== true,
    'Relay: getRefetchMetadata(): Expected fragment `%s` not to be plural when using ' +
      '`%s`. Remove `@relay(plural: true)` from fragment `%s` ' +
      'in order to use it with `%s`.',
    fragmentNode.name,
    componentDisplayName,
    fragmentNode.name,
    componentDisplayName,
  );

  const refetchMetadata = fragmentNode.metadata?.refetch;
  invariant(
    refetchMetadata != null,
    'Relay: getRefetchMetadata(): Expected fragment `%s` to be refetchable when using `%s`. ' +
      'Did you forget to add a @refetchable directive to the fragment?',
    componentDisplayName,
    fragmentNode.name,
  );

  // handle both commonjs and es modules
  const refetchableRequest:
    | ConcreteRequest
    | string = (refetchMetadata: $FlowFixMe).operation.default
    ? (refetchMetadata: $FlowFixMe).operation.default
    : refetchMetadata.operation;
  const fragmentRefPathInResponse = refetchMetadata.fragmentPathInResult;
  invariant(
    typeof refetchableRequest !== 'string',
    'Relay: getRefetchMetadata(): Expected refetch query to be an ' +
      "operation and not a string when using `%s`. If you're seeing this, " +
      'this is likely a bug in Relay.',
    componentDisplayName,
  );
  return {refetchableRequest, fragmentRefPathInResponse, refetchMetadata};
}

module.exports = getRefetchMetadata;
