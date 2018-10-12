/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 * @format
 * @emails oncall+relay
 */

'use strict';

const LRUCache_UNSTABLE = require('../utils/LRUCache_UNSTABLE');
const React = require('React');

const checkQuery_UNSTABLE = require('../helpers/checkQuery_UNSTABLE');
const getRequestKey_UNSTABLE = require('../helpers/getRequestKey_UNSTABLE');
const invariant = require('invariant');
const mapObject = require('mapObject');
const readQuery_UNSTABLE = require('../helpers/readQuery_UNSTABLE');

// TODO: This should probably be configurable based on the environment
const CACHE_CAPACITY = 1000;

const {
  fetchQuery_UNSTABLE,
  getPromiseForRequestInFlight_UNSTABLE,
} = require('../helpers/fetchQuery_UNSTABLE');
const {
  getDataIDsFromObject,
  getRequest,
  getSelectorsFromObject,
} = require('relay-runtime');

import type {
  ConcreteFragment,
  Disposable,
  GraphQLTaggedNode,
  IEnvironment,
  Selector,
  Snapshot,
  Variables,
} from 'relay-runtime';

type CachedValue = Error | Promise<void> | Snapshot | $ReadOnlyArray<Snapshot>;
type CacheReadResult = {
  snapshot: Snapshot | $ReadOnlyArray<Snapshot>,
  data: mixed,
  fetchDisposable: Disposable | null,
};

export type ReadPolicy = 'eager' | 'lazy';
export type FetchPolicy =
  | 'store-only'
  | 'store-or-network'
  | 'store-and-network'
  | 'network-only';

const DATA_RETENTION_TIMEOUT = 30 * 1000;

function getQueryCacheKey(
  query: GraphQLTaggedNode,
  variables: Variables,
): string {
  const requestNode = getRequest(query);
  return getRequestKey_UNSTABLE(requestNode, variables);
}

function getFragmentCacheKey(
  fragmentNode: ConcreteFragment,
  fragmentRef: mixed,
  variables: Variables,
): string {
  return JSON.stringify({
    dataIDs: getDataIDsFromObject(
      {[fragmentNode.name]: fragmentNode},
      {[fragmentNode.name]: fragmentRef},
    ),
    variables,
  });
}

function isMissingData(snapshot: Snapshot | $ReadOnlyArray<Snapshot>) {
  if (Array.isArray(snapshot)) {
    return snapshot.some(s => s.isMissingData);
  }
  return snapshot.isMissingData;
}

function createCache() {
  const cache = LRUCache_UNSTABLE.create<CachedValue>(CACHE_CAPACITY);

  /**
   * Attempts to fetch, retain and store data for a query, based on the
   * provided fetchPolicy and readPolicy,
   * ReadPolicy:
   * - eager:
   *   - Will try to read as much data as possible, even if the full query is
   *     not available in the Relay store. If any data is available, it will be
   *     saved to the cache.
   * - lazy:
   *   - Will not read a query from the store unless the full query is available
   *     in the Relay store. If the full query is available, it will be saved
   *     to the cache.
   *
   * FetchPolicy:
   * - store-only:
   *   - Will read the query from the Relay Store and save it to cache based on
   *     the specified ReadPolicy.
   *   - It will not make any network requests
   *   - It will throw an error if there are no pending network requests
   * - store-or-network:
   *   - Will read the query from the Relay Store and save it to cache based on
   *     the specified ReadPolicy.
   *   - If data was available from read, it will not make any network requests.
   *   - If not, it will attempt to fetch the query from the network.
   * - store-and-network:
   *   - Will read the query from the Relay Store and save it to cache based on
   *     the specified ReadPolicy.
   *   - Additionally, it will always attempt to fetch the query.
   * - network-only:
   *   - Will only attempt to fetch the query without reading from the
   *     Relay Store.
   *
   * fetchQuery will de-dupe requests that are in flight (globally) by default.
   * This function will save the result from the network fetch to the cache:
   *   - If result from network is available synchronously, it will be saved
   *     to cache.
   *   - If result from network is not available synchronously, a Promise
   *     for the request will be saved to cache.
   *   - When the request completes, the result or the error will be saved to
   *     to cache.
   *
   * After the request completes, this function will release the retained data
   * after some period of time determined by DATA_RETENTION_TIMEOUT.
   * The timeout can be cleared by the Disposable returned by this function.
   */
  function fetchQuery(args: {|
    environment: IEnvironment,
    query: GraphQLTaggedNode,
    variables: Variables,
    fetchPolicy?: FetchPolicy,
    readPolicy?: ReadPolicy,
  |}): Disposable {
    const {environment, query, variables} = args;
    const cacheKey = getQueryCacheKey(query, variables);
    const fetchPolicy = args.fetchPolicy ?? 'network-only';
    const readPolicy = args.readPolicy ?? 'lazy';

    // NOTE: Running `check` will write missing data to the store using any
    // missing data handlers specified on the environment;
    // We run it here first to make the handlers get a chance to populate
    // missing data.
    const hasFullQuery = checkQuery_UNSTABLE(environment, query, variables);

    const canRead = readPolicy === 'lazy' ? hasFullQuery : true;
    let shouldFetch;
    switch (fetchPolicy) {
      case 'store-only': {
        shouldFetch = false;
        if (canRead) {
          const snapshot = readQuery_UNSTABLE(environment, query, variables);
          if (!isMissingData(snapshot)) {
            cache.set(cacheKey, snapshot);
            break;
          }
        }
        // Check if there's a global request in flight for this query, even
        // if one won't be initiated by the component associated with this render.
        // It is possible for queries to be fetched completely outside of React
        // rendering, which is why we check if a request is in flight globally
        // for this query.
        const promiseForQuery = getPromiseForQueryRequestInFlight({
          environment,
          query,
          variables,
        });
        if (promiseForQuery != null) {
          cache.set(cacheKey, promiseForQuery);
          break;
        }
        throw new Error(
          'DataResourceCache_UNSTABLE: Tried reading a query that is not available locally and is not being fetched',
        );
      }
      case 'store-or-network': {
        if (canRead) {
          shouldFetch = !hasFullQuery;
          const snapshot = readQuery_UNSTABLE(environment, query, variables);
          if (!isMissingData(snapshot)) {
            cache.set(cacheKey, snapshot);
          }
        } else {
          shouldFetch = true;
        }
        break;
      }
      case 'store-and-network': {
        shouldFetch = true;
        if (canRead) {
          const snapshot = readQuery_UNSTABLE(environment, query, variables);
          if (!isMissingData(snapshot)) {
            cache.set(cacheKey, snapshot);
          }
        }
        break;
      }
      case 'network-only':
      default: {
        shouldFetch = true;
        break;
      }
    }

    let releaseDataTimeoutID = null;
    let disposable: ?Disposable = null;
    if (shouldFetch) {
      let resolveSuspender = () => {};
      let error = null;
      disposable = fetchQuery_UNSTABLE({
        environment,
        query,
        variables,
        networkLayerCacheConfig: {force: true},
        observer: {
          complete: () => {
            // NOTE: fetchQuery_UNSTABLE retains data in the Relay store by default.
            // We dispose of it eventually here since the component associated
            // with this request might never mount. If it does mount, it will
            // retain the data and release it on unmount, so we try to give it
            // enough time to mount here.
            // If the component never mounts, we ensure here the data is eventually
            // released.
            releaseDataTimeoutID = setTimeout(() => {
              if (disposable) {
                disposable.dispose();
                disposable = null;
              }
            }, DATA_RETENTION_TIMEOUT);
            resolveSuspender();
          },
          next: () => {
            const snapshot = readQuery_UNSTABLE(environment, query, variables);
            if (!isMissingData(snapshot)) {
              cache.set(cacheKey, snapshot);
              resolveSuspender();
            }
          },
          error: e => {
            error = e;
            if (disposable) {
              disposable.dispose();
              disposable = null;
            }
            cache.set(cacheKey, error);
            resolveSuspender();
          },
        },
      });
      if (!cache.has(cacheKey)) {
        const suspender = new Promise(resolve => {
          resolveSuspender = resolve;
        });
        cache.set(cacheKey, suspender);
      }
    }
    return {
      // Dispose should be called by the component when it mounts.
      // The expectation is that the component will retain the data for the
      // query separately, and thus can allow this fetch call to stop retaining it
      dispose: () => {
        if (releaseDataTimeoutID) {
          if (disposable) {
            disposable.dispose();
          }
          clearTimeout(releaseDataTimeoutID);
        }
      },
    };
  }

  /**
   * Checks if a request for a query is in flight globally, and if so, returns
   * a Promise for that query.
   * Before the promise resolves, it will store in cache the latest data from
   * the Relay store for the query, or an error if one occurred during the
   * request.
   */
  function getPromiseForQueryRequestInFlight(args: {|
    environment: IEnvironment,
    query: GraphQLTaggedNode,
    variables: Variables,
  |}): Promise<void> | null {
    const {environment, query, variables} = args;
    const promise = getPromiseForRequestInFlight_UNSTABLE({
      environment,
      query,
      variables,
    });
    if (!promise) {
      return null;
    }

    const cacheKey = getQueryCacheKey(query, variables);
    // When the Promise for the request resolves, we need to make sure to
    // update the cache with the latest data available in the store before
    // resolving the Promise
    return promise
      .then(() => {
        const latestSnapshot = readQuery_UNSTABLE(
          environment,
          query,
          variables,
        );
        if (!isMissingData(latestSnapshot)) {
          cache.set(cacheKey, latestSnapshot);
        } else {
          cache.delete(cacheKey);
        }
      })
      .catch(error => {
        cache.set(cacheKey, error);
      });
  }

  /**
   * Checks if a request for a the parent query for a fragment is in flight
   * globally, and if so, returns a Promise for that query.
   * Before the promise resolves, it will store in cache the latest data from
   * the Relay store for the fragment, or an error if one occurred during the
   * request.
   */
  function getPromiseForFragmentRequestInFlight(args: {|
    environment: IEnvironment,
    fragmentNode: ConcreteFragment,
    fragmentRef: mixed,
    fragmentSelector: Selector,
    parentQuery: GraphQLTaggedNode,
    variables: Variables,
  |}): Promise<void> | null {
    const {
      environment,
      fragmentNode,
      fragmentRef,
      fragmentSelector,
      parentQuery,
      variables,
    } = args;
    const promise = getPromiseForRequestInFlight_UNSTABLE({
      environment,
      query: parentQuery,
      variables,
    });
    if (!promise) {
      return null;
    }

    const cacheKey = getFragmentCacheKey(fragmentNode, fragmentRef, variables);
    // When the Promise for the request resolves, we need to make sure to
    // update the cache with the latest data available in the store before
    // resolving the Promise
    return promise
      .then(() => {
        const latestSnapshot = environment.lookup(fragmentSelector);
        if (!isMissingData(latestSnapshot)) {
          cache.set(cacheKey, latestSnapshot);
        }
      })
      .catch(error => {
        cache.set(cacheKey, error);
      });
  }

  /**
   * Builds a result to return when reading from this cache.
   * The result includes:
   * - The Relay store Snapshot, which is necessary if callers want to
   *   subscribe to the snapshot's data.
   * - The actual data from the Snapshot.
   */
  function makeDataResult(args: {|
    snapshot: Snapshot | $ReadOnlyArray<Snapshot>,
    fetchDisposable?: Disposable,
  |}): CacheReadResult {
    const {fetchDisposable, snapshot} = args;
    return {
      data: Array.isArray(snapshot)
        ? snapshot.map(({data}) => data)
        : snapshot.data,
      fetchDisposable: fetchDisposable ?? null,
      snapshot,
    };
  }

  return {
    /**
     * Attempts to read data from the render cache.
     * - When a cached value is available:
     *   - If value is a Promise or Error, it will be thrown.
     *   - Otherwise, return it.
     * - When a cached value is NOT available:
     *   - Attempts to read from Relay Store, and caches data if it's in the store.
     *   - If data not present, check if request is in flight, if so throw
     *     Promise for that request
     *   - Otherwise, return empty data.
     */
    readQuery(args: {|
      environment: IEnvironment,
      query: GraphQLTaggedNode,
      variables: Variables,
      fetchPolicy?: FetchPolicy,
      readPolicy?: ReadPolicy,
    |}): CacheReadResult {
      const {query, variables} = args;
      const cacheKey = getQueryCacheKey(query, variables);

      // 1. Check if there's a cached value for this query
      let cachedValue = cache.get(cacheKey);
      if (cachedValue != null) {
        if (cachedValue instanceof Promise || cachedValue instanceof Error) {
          throw cachedValue;
        }
        return makeDataResult({
          snapshot: cachedValue,
        });
      }

      // 2. If a cached value isn't available, try fetching the query.
      // fetchQuery will update the cache with either a Promise, Error or a
      // Snapshot
      const fetchDisposable = fetchQuery(args);
      cachedValue = cache.get(cacheKey);
      if (cachedValue != null) {
        if (cachedValue instanceof Promise || cachedValue instanceof Error) {
          throw cachedValue;
        }
        return makeDataResult({
          snapshot: cachedValue,
          fetchDisposable,
        });
      }

      // 3. If a cached value still isn't available, throw an error.
      // This means that we're trying to read a query that isn't available and
      // isn't being fetched at all.
      // This can happen if the fetchPolicy policy is store-only
      throw new Error(
        'DataResourceCache_UNSTABLE: Tried reading a query that is not available locally and is not being fetched',
      );
    },

    readFragmentSpec(args: {|
      environment: IEnvironment,
      variables: Variables,
      fragmentNodes: {[key: string]: ConcreteFragment},
      fragmentRefs: {[string]: mixed},
      parentQuery: GraphQLTaggedNode,
    |}): {[string]: CacheReadResult} {
      const {
        environment,
        fragmentNodes,
        fragmentRefs,
        parentQuery,
        variables,
      } = args;

      const selectorsByFragment = getSelectorsFromObject(
        variables,
        fragmentNodes,
        fragmentRefs,
      );
      return mapObject(fragmentNodes, (fragmentNode, key) => {
        const fragmentRef = fragmentRefs[key];
        const cacheKey = getFragmentCacheKey(
          fragmentNode,
          fragmentRef,
          variables,
        );
        const cachedValue = cache.get(cacheKey);

        // 1. Check if there's a cached value for this fragment
        if (cachedValue != null) {
          if (cachedValue instanceof Promise || cachedValue instanceof Error) {
            throw cachedValue;
          }
          return makeDataResult({
            snapshot: cachedValue,
          });
        }

        // 2. If not, try reading the fragment from the Relay store.
        // If the snapshot has data, return it and save it in cache
        const fragmentSelector = selectorsByFragment[key];
        invariant(
          fragmentSelector != null,
          'DataResourceCache_UNSTABLE: Expected selector to be available',
        );
        const snapshot = environment.lookup(fragmentSelector);
        if (!isMissingData(snapshot)) {
          cache.set(cacheKey, snapshot);
          return makeDataResult({
            snapshot,
          });
        }

        // 3. If we don't have data in the store, check if a request is in
        // flight for the fragment's parent query. If so, suspend with the Promise
        // for that request.
        const suspender = getPromiseForFragmentRequestInFlight({
          environment,
          fragmentNode,
          fragmentRef,
          fragmentSelector,
          parentQuery,
          variables,
        });
        if (suspender != null) {
          throw suspender;
        }

        // 3. If a cached value still isn't available, throw an error.
        // This means that we're trying to read a query that isn't available and
        // isn't being fetched at all.
        // This can happen if the fetchPolicy policy is store-only
        throw new Error(
          'DataResourceCache_UNSTABLE: Tried reading a fragment that is not available locally and is not being fetched',
        );
      });
    },

    /**
     * If a query isn't already saved in cache, attempts to fetch, retain and
     * store data for a query, based on the provided data access policy.
     * See: fetchQuery.
     */
    preloadQuery(args: {|
      environment: IEnvironment,
      query: GraphQLTaggedNode,
      variables: Variables,
      fetchPolicy?: FetchPolicy,
      readPolicy?: ReadPolicy,
    |}): Disposable {
      const {environment, query, variables, fetchPolicy, readPolicy} = args;
      const cacheKey = getQueryCacheKey(query, variables);
      if (cache.has(cacheKey)) {
        return {dispose: () => {}};
      }
      return fetchQuery({
        environment,
        query,
        variables,
        fetchPolicy,
        readPolicy,
      });
    },

    /**
     * Removes entry for query from cache
     */
    invalidateQuery(args: {|query: GraphQLTaggedNode, variables: Variables|}) {
      const {query, variables} = args;
      const cacheKey = getQueryCacheKey(query, variables);
      cache.delete(cacheKey);
    },

    /**
     * Removes entry for fragment from cache
     */
    invalidateFragment(args: {|
      fragmentNode: ConcreteFragment,
      fragmentRef: mixed,
      variables: Variables,
    |}): void {
      const {fragmentNode, fragmentRef, variables} = args;
      const cacheKey = getFragmentCacheKey(
        fragmentNode,
        fragmentRef,
        variables,
      );
      cache.delete(cacheKey);
    },

    /**
     * Removes entry for each provided fragment from cache
     */
    invalidateFragmentSpec(args: {|
      fragmentNodes: {[key: string]: ConcreteFragment},
      fragmentRefs: {[string]: mixed},
      variables: Variables,
    |}): void {
      const {fragmentNodes, fragmentRefs, variables} = args;
      Object.keys(fragmentNodes).forEach(key => {
        const fragmentNode = fragmentNodes[key];
        const fragmentRef = fragmentRefs[key];
        invariant(
          fragmentNode != null,
          'RenderDataResource: Expected fragment to be defined',
        );

        const cacheKey = getFragmentCacheKey(
          fragmentNode,
          fragmentRef,
          variables,
        );
        cache.delete(cacheKey);
      });
    },

    /**
     * Sets snapshot for query in cache if data in snapshot isn't empty
     */
    setQuery(args: {|
      query: GraphQLTaggedNode,
      variables: Variables,
      snapshot: Snapshot,
    |}): void {
      const {query, snapshot, variables} = args;
      if (!isMissingData(snapshot)) {
        const cacheKey = getQueryCacheKey(query, variables);
        cache.set(cacheKey, snapshot);
      }
    },

    /**
     * Sets snapshot in cache for provided fragment if data in snapshot
     * isn't empty
     */
    setFragment(args: {|
      fragmentNode: ConcreteFragment,
      fragmentRef: mixed,
      variables: Variables,
      snapshot: Snapshot | $ReadOnlyArray<Snapshot>,
    |}): void {
      const {fragmentNode, fragmentRef, variables, snapshot} = args;
      if (!isMissingData(snapshot)) {
        const cacheKey = getFragmentCacheKey(
          fragmentNode,
          fragmentRef,
          variables,
        );
        cache.set(cacheKey, snapshot);
      }
    },
  };
}

const cachesByEnvironment: Map<IEnvironment, TDataResourceCache> = new Map();
function getCacheForEnvironment(environment: IEnvironment): TDataResourceCache {
  let cache = cachesByEnvironment.get(environment);
  if (cache) {
    return cache;
  }
  cache = createCache();
  cachesByEnvironment.set(environment, cache);
  return cache;
}

export type TDataResourceCache = $Call<<R>(() => R) => R, typeof createCache>;

const globalCache = createCache();
const DataResourceCacheContext = React.createContext(globalCache);

module.exports = {
  createCache,
  getCacheForEnvironment,
  DataResourceCacheContext,
};
