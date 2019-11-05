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

const {getModuleComponentKey, getModuleOperationKey} = require('relay-runtime');

import type {NormalizationSplitOperation} from 'relay-runtime';

export opaque type Local3DPayload<+DocumentName: string, +Response: {}> = empty;

interface Resource<T> {
  +getModuleIfRequired: () => ?T;
  +getModuleId: () => string;
  +load: () => Promise<T>;
}

function createPayloadFor3DField<+DocumentName: string, +Response>(
  name: DocumentName,
  operation: Resource<NormalizationSplitOperation>,
  component: Resource<mixed>,
  response: Response,
  /* $FlowFixMe(>=0.111.0) This comment suppresses an error found when Flow
   * v0.111.0 was deployed. To see the error, delete this comment and run Flow.
   */
): Local3DPayload<DocumentName, Response> {
  const data = {
    ...response,
  };
  data[getModuleComponentKey(name)] = component;
  data[getModuleOperationKey(name)] = operation;
  /* $FlowFixMe(>=0.111.0) This comment suppresses an error found when Flow
   * v0.111.0 was deployed. To see the error, delete this comment and run Flow.
   */
  return data;
}

module.exports = createPayloadFor3DField;
