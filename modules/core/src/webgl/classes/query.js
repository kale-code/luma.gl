// WebGL2 Query (also handles disjoint timer extensions)
import Resource from './resource';
import {FEATURES, hasFeatures} from '../features';
import {isWebGL2} from '../utils';
import queryManager from '../utils/query-manager';
import {assert} from '../../utils';

const noop = x => x;

const ERR_GPU_DISJOINT = 'Disjoint GPU operation invalidated timer queries';
const ERR_TIMER_QUERY_NOT_SUPPORTED = 'Timer queries require "EXT_disjoint_timer_query" extension';

const GL_QUERY_COUNTER_BITS_EXT = 0x8864; // # bits in query result for the given target.

const GL_QUERY_RESULT = 0x8866; // Returns a GLuint containing the query result.
const GL_QUERY_RESULT_AVAILABLE = 0x8867; // whether query result is available.

const GL_TIME_ELAPSED_EXT = 0x88bf; // Elapsed time (in nanoseconds).
const GL_TIMESTAMP_EXT = 0x8e28; // The current time.
const GL_GPU_DISJOINT_EXT = 0x8fbb; // Whether GPU performed any disjoint operation.

const GL_TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN = 0x8c88; // #primitives written to feedback buffers
const GL_ANY_SAMPLES_PASSED = 0x8c2f; // Occlusion query (if drawing passed depth test)
const GL_ANY_SAMPLES_PASSED_CONSERVATIVE = 0x8d6a; // Occlusion query less accurate/faster version

export default class Query extends Resource {
  // Returns true if Query is supported by the WebGL implementation
  // Can also check whether timestamp queries are available.
  static isSupported(gl, opts = []) {
    const webgl2 = isWebGL2(gl);

    // Initial value
    const hasTimerQuery = hasFeatures(gl, FEATURES.TIMER_QUERY);
    let supported = webgl2 || hasTimerQuery;

    for (const key of opts) {
      switch (key) {
        case 'queries':
          supported = supported && webgl2;
          break;
        case 'timers':
          supported = supported && hasTimerQuery;
          break;
        case 'timestamps':
          const queryCounterBits = hasTimerQuery
            ? gl.getQuery(GL_TIMESTAMP_EXT, GL_QUERY_COUNTER_BITS_EXT)
            : 0;
          supported = supported && queryCounterBits > 0;
          break;
        default:
          assert(false);
      }
    }

    return supported;
  }

  // Create a query class
  constructor(gl, opts = {}) {
    super(gl, opts);

    const {onComplete = noop, onError = noop} = opts;

    this.target = null;
    this.queryPending = false;
    this.onComplete = onComplete;
    this.onError = onError;

    // query manager needs a promise field
    this.promise = null;

    Object.seal(this);
  }

  // Shortcut for timer query (dependent on extension in both WebGL1 and 2)
  // Measures GPU time delta between this call and a matching `end` call in the
  // GPU instruction stream.
  beginTimeElapsedQuery() {
    return this.begin(GL_TIME_ELAPSED_EXT);
  }

  // Shortcut for occlusion queries
  beginOcclusionQuery({conservative = false} = {}) {
    return this.begin(conservative ? GL_ANY_SAMPLES_PASSED_CONSERVATIVE : GL_ANY_SAMPLES_PASSED);
  }

  // Shortcut for transformFeedbackQuery
  beginTransformFeedbackQuery() {
    return this.begin(GL_TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN);
  }

  // Generates a GPU time stamp when the GPU instruction stream reaches this instruction.
  // To measure time deltas, two timestamp queries are needed.
  // Note: timestamp() queries may not be available even when the timer query extension is.
  getTimestamp() {
    queryManager.beginQuery(this, this.onComplete, this.onError);
    try {
      this.gl.queryCounter(this.handle, GL_TIMESTAMP_EXT);
    } catch (error) {
      queryManager.rejectQuery(this, ERR_TIMER_QUERY_NOT_SUPPORTED);
    }
    return this;
  }

  // Due to OpenGL API limitations, after calling `begin()` on one Query
  // instance, `end()` must be called on that same instance before
  // calling `begin()` on another query. While there can be multiple
  // outstanding queries representing disjoint `begin()`/`end()` intervals.
  // It is not possible to interleave or overlap `begin` and `end` calls.
  begin(target) {
    // Don't start a new query if one is already active.
    if (this.queryPending) {
      return this;
    }

    // - Triggering a new query when a Query is already tracking an
    //   unresolved query causes that query to be cancelled.
    queryManager.beginQuery(this, this.onComplete, this.onError);
    this.target = target;

    try {
      this.gl.beginQuery(this.target, this.handle);
    } catch (error) {
      queryManager.rejectQuery(this, 'Query not supported');
    }
    return this;
  }

  // ends the current query
  end() {
    // Can't end a new query if the last one hasn't been resolved.
    if (this.queryPending) {
      return this;
    }

    // Note: calling end does not affect the pending promise
    if (this.target) {
      this.gl.endQuery(this.target);
      this.target = null;
      this.queryPending = true;
    }
    return this;
  }

  // Cancels a pending query
  cancel() {
    this.end();
    queryManager.cancelQuery(this);
    return this;
  }

  // Returns true if the query result is available
  isResultAvailable() {
    if (!this.queryPending) {
      return false;
    }

    const resultAvailable = this.gl.getQueryParameter(this.handle, GL_QUERY_RESULT_AVAILABLE);
    if (resultAvailable) {
      this.queryPending = false;
    }
    return resultAvailable;
  }

  // Timing query is disjoint, i.e. results are invalid
  isTimerDisjoint() {
    return this.gl.getParameter(GL_GPU_DISJOINT_EXT);
  }

  // Returns query result.
  getResult() {
    return this.gl.getQueryParameter(this.handle, GL_QUERY_RESULT);
  }

  // Returns the query result, converted to milliseconds to match JavaScript conventions.
  getTimerMilliseconds() {
    return this.getResult() / 1e6;
  }

  static poll(gl) {
    queryManager.poll(gl);
  }

  _createHandle() {
    return Query.isSupported(this.gl) ? this.gl.createQuery() : null;
  }

  _deleteHandle() {
    queryManager.deleteQuery(this);
    this.gl.deleteQuery(this.handle);
  }
}

// NOTE: This call lets the queryManager know how to detect disjoint GPU state
// It will check dsjoint state on polls and before adding a new query
// and reject any outstanding TimerQueries with our supplied error message.
queryManager.setInvalidator({
  queryType: Query,
  errorMessage: ERR_GPU_DISJOINT,
  // Note: Querying the disjoint state resets it
  checkInvalid: gl => gl.getParameter(GL_GPU_DISJOINT_EXT)
});
