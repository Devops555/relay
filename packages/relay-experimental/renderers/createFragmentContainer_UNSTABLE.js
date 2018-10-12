/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 * @format
 */

'use strict';

const React = require('React');
const ReactRelayContext = require('react-relay/modern/ReactRelayContext');

const areEqual = require('areEqual');
const assertFragmentMap = require('react-relay/modern/assertFragmentMap');
const forEachObject = require('forEachObject');
const getRelayProp_UNSTABLE = require('../helpers/getRelayProp_UNSTABLE');
const invariant = require('invariant');
const mapObject = require('mapObject');

const {DataResourceCacheContext} = require('./DataResourceCache_UNSTABLE');
const {
  getComponentName,
  getContainerName,
} = require('react-relay/modern/ReactRelayContainerUtils');
const {getFragment} = require('relay-runtime');

import type {TDataResourceCache} from './DataResourceCache_UNSTABLE';
import type {
  GeneratedNodeMap,
  RelayProp,
  $RelayProps,
} from 'react-relay/modern/ReactRelayTypes';
import type {
  Disposable,
  GraphQLTaggedNode,
  Snapshot,
  RelayContext,
} from 'relay-runtime';

function createFragmentContainer_UNSTABLE<
  Props: {},
  TComponent: React.ComponentType<Props>,
>(
  Component: TComponent,
  fragmentSpecInput: GraphQLTaggedNode | GeneratedNodeMap,
): React.ComponentType<
  $RelayProps<React.ElementConfig<TComponent>, RelayProp>,
> {
  type InternalProps = {|
    DataResourceCache: TDataResourceCache,
    forwardedRef: React.Ref<TComponent>,
    fragmentRefs: {[string]: mixed},
    relayContext: RelayContext & {query: GraphQLTaggedNode},
  |};

  type State = {|
    mirroredFragmentRefs: {[string]: mixed},
  |};

  const containerName = getContainerName(Component);
  assertFragmentMap(getComponentName(Component), fragmentSpecInput);

  // $FlowExpectedError - The compiler converts a GraphQLTaggedNode into a GeneratedNodeMap for us
  const fragmentSpec: GeneratedNodeMap = (fragmentSpecInput: any);
  const concreteFragmentMap = mapObject(fragmentSpec, getFragment);

  class FragmentRenderer extends React.Component<InternalProps, State> {
    _dataSubscriptions: Array<Disposable> | null = null;
    _renderedSnapshots: {[string]: Snapshot | $ReadOnlyArray<Snapshot>} = {};

    constructor(props: InternalProps) {
      super(props);
      const {fragmentRefs} = props;
      this.state = {
        mirroredFragmentRefs: fragmentRefs,
      };
    }

    static getDerivedStateFromProps(
      nextProps: InternalProps,
      prevState: State,
    ): $Shape<State> | null {
      const {DataResourceCache, fragmentRefs, relayContext} = nextProps;

      const {environment, variables} = relayContext;
      const {getDataIDsFromObject} = environment.unstable_internal;
      const prevDataIDs = getDataIDsFromObject(
        concreteFragmentMap,
        prevState.mirroredFragmentRefs,
      );
      const nextDataIDs = getDataIDsFromObject(
        concreteFragmentMap,
        fragmentRefs,
      );
      if (!areEqual(prevDataIDs, nextDataIDs)) {
        DataResourceCache.invalidateFragmentSpec({
          fragmentSpec,
          fragmentRefs,
          variables,
        });
        return {
          mirroredFragmentRefs: fragmentRefs,
        };
      }
      return null;
    }

    componentDidMount() {
      // TODO Check if data has changed between render and mount. Schedule another
      // update if so
      this._unsubscribe();
      this._subscribe();
    }

    componentDidUpdate(prevProps: InternalProps, prevState: State) {
      // TODO Check if data has changed between render and update. Schedule another
      // update if so
      const mustResubscribe =
        prevProps.relayContext !== this.props.relayContext ||
        prevState.mirroredFragmentRefs !== this.state.mirroredFragmentRefs;
      if (mustResubscribe) {
        this._unsubscribe();
        this._subscribe();
      }
    }

    componentWillUnmount() {
      const {DataResourceCache, fragmentRefs, relayContext} = this.props;
      const {variables} = relayContext;
      this._unsubscribe();

      // We invalidate on unmount because we want to allow a component that is
      // remounting in the future to read fresh data from the Relay store
      // If we didn't, new mounts of the component would always find the data
      // cached in DataResourceCache and not read from the store
      DataResourceCache.invalidateFragmentSpec({
        fragmentSpec,
        fragmentRefs,
        variables,
      });
    }

    _handleDataUpdate(fragmentKey, latestSnapshot) {
      const {DataResourceCache, fragmentRefs, relayContext} = this.props;
      const {variables} = relayContext;

      const fragment = fragmentSpec[fragmentKey];
      invariant(
        fragment != null,
        'SuspenseFragmentContainer: Expected fragment to be available during update',
      );
      const fragmentRef = fragmentRefs[fragmentKey];
      DataResourceCache.setFragment({
        fragment,
        fragmentRef,
        variables,
        snapshot: latestSnapshot,
      });
      this.forceUpdate();
    }

    _subscribe() {
      const {relayContext} = this.props;
      const {environment} = relayContext;
      const dataSubscriptions = this._dataSubscriptions ?? [];
      forEachObject(this._renderedSnapshots, (snapshot, key) => {
        invariant(
          snapshot !== null,
          'SuspenseFragmentContainer: Expected to have rendered with a snapshot',
        );
        if (Array.isArray(snapshot)) {
          snapshot.forEach(s => {
            dataSubscriptions.push(
              environment.subscribe(s, latestSnapshot =>
                this._handleDataUpdate(key, latestSnapshot),
              ),
            );
          });
        } else {
          dataSubscriptions.push(
            environment.subscribe(snapshot, latestSnapshot =>
              this._handleDataUpdate(key, latestSnapshot),
            ),
          );
        }
      });
      this._dataSubscriptions = dataSubscriptions;
    }

    _unsubscribe() {
      if (this._dataSubscriptions != null) {
        this._dataSubscriptions.map(s => s.dispose());
        this._dataSubscriptions = null;
      }
    }

    render() {
      const {
        DataResourceCache,
        forwardedRef,
        fragmentRefs,
        relayContext,
      } = this.props;
      const {environment, query, variables} = relayContext;
      const readResult = DataResourceCache.readFragmentSpec({
        environment,
        fragmentSpec,
        fragmentRefs,
        parentQuery: query,
        variables,
      });

      this._renderedSnapshots = {};
      const data = {};
      forEachObject(readResult, (result, key) => {
        invariant(
          result != null,
          'SuspenseFragmentContainer: Expected to have read data',
        );
        data[key] = result.data;
        // WARNING: Keeping instance variables in render can be unsafe; however,
        // in this case it is safe because we're ensuring they are only used in the
        // commit phase.
        this._renderedSnapshots[key] = result.snapshot;
      });

      return (
        <Component
          {...fragmentRefs}
          {...data}
          ref={forwardedRef}
          relay={getRelayProp_UNSTABLE(environment)}
        />
      );
    }
  }

  const FragmentContainer = (props, ref) => {
    // $FlowFixMe - TODO T35024201 unstable_read is not yet typed
    const DataResourceCache = DataResourceCacheContext.unstable_read();
    // $FlowFixMe - TODO T35024201 unstable_read is not yet typed
    const relayContext = ReactRelayContext.unstable_read();
    invariant(
      relayContext != null,
      `SuspenseFragmentContainer: ${containerName} tried to render with ` +
        `missing context. This means that ${containerName} was not rendered ` +
        'as a descendant of a QueryRenderer.',
    );
    invariant(
      relayContext.query != null,
      `SuspenseFragmentContainer: ${containerName} tried to render without ` +
        `a query provided in context. This means that ${containerName} was ` +
        'not rendered as a descendant of a QueryRenderer.',
    );

    if (__DEV__) {
      const {isRelayModernEnvironment} = require('relay-runtime');
      if (!isRelayModernEnvironment(relayContext.environment)) {
        throw new Error(
          'SuspenseFragmentContainer: Can only use SuspenseFragmentContainer ' +
            `${containerName} in a Relay Modern environment!\n` +
            'When using Relay Modern and Relay Classic in the same ' +
            'application, ensure components use Relay Compat to work in ' +
            'both environments.\n' +
            'See: http://facebook.github.io/relay/docs/relay-compat.html',
        );
      }
    }

    return (
      <FragmentRenderer
        relayContext={relayContext}
        DataResourceCache={DataResourceCache}
        fragmentRefs={props}
        forwardedRef={ref}
      />
    );
  };
  FragmentContainer.displayName = containerName;

  // $FlowFixMe - TODO T29156721 forwardRef isn't Flow typed yet
  const ForwardRefFragmentContainer = React.forwardRef(FragmentContainer);

  if (__DEV__) {
    ForwardRefFragmentContainer.__ComponentClass = Component;
  }
  return ForwardRefFragmentContainer;
}

module.exports = createFragmentContainer_UNSTABLE;
