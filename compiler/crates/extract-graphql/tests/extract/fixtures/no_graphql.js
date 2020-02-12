/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const oops = [
    graphqlgraphql`not matching1`,
    graphqlabc`not matching2`,
    _graphql`not matching3`,
    abcgraphql`not matching4`,
    " graphql`in string` ",
    " \" graphql`in string` ",
    ' graphql`in string` ',
    ' \' graphql`in string` ',
    // graphql`in comment`
    /* graphql`in comment` */
];
