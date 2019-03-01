/* global OffscreenCanvas, window, navigator, VRFrameData */

import {
  createGLContext,
  instrumentGLContext,
  resizeGLContext,
  resetParameters
} from '../webgl/context';
import {getPageLoadPromise} from '../webgl/context';
import {isWebGL, requestAnimationFrame, cancelAnimationFrame} from '../webgl/utils';
import {log} from '../utils';
import assert from '../utils/assert';
import {Stats} from 'probe.gl';
import {Query} from '../webgl';
import {withParameters} from '../webgl/context';
import {createEnterVRButton} from '../utils/webvr';

// TODO - remove dependency on webgl classes
import {Framebuffer} from '../webgl';

let statIdCounter = 0;

export default class AnimationLoop {
  /*
   * @param {HTMLCanvasElement} canvas - if provided, width and height will be passed to context
   */
  constructor(props = {}) {
    const {
      onCreateContext = opts => createGLContext(opts),
      onAddHTML = null,
      onInitialize = () => {},
      onRender = () => {},
      onRenderFrame = null,
      onFinalize = () => {},

      gl = null,
      glOptions = {},
      debug = false,

      createFramebuffer = false,

      // view parameters
      autoResizeViewport = true,
      autoResizeDrawingBuffer = true,
      stats = new Stats({id: `animation-loop-${statIdCounter++}`})
    } = props;

    let {useDevicePixels = true} = props;

    if ('useDevicePixelRatio' in props) {
      log.deprecated('useDevicePixelRatio', 'useDevicePixels')();
      useDevicePixels = props.useDevicePixelRatio;
    }

    this.props = {
      onCreateContext,
      onAddHTML,
      onInitialize,
      onRender,
      onRenderFrame,
      onFinalize,

      gl,
      glOptions,
      debug,
      createFramebuffer
    };

    // state
    this.gl = gl;
    this.needsRedraw = null;
    this.stats = stats;
    this.cpuTime = this.stats.get('CPU Time');
    this.gpuTime = this.stats.get('GPU Time');
    this.frameRate = this.stats.get('Frame Rate');

    this._initialized = false;
    this._running = false;
    this._animationFrameId = null;
    this._nextFramePromise = null;
    this._resolveNextFrame = null;
    this._cpuStartTime = 0;

    this._canvasDataURLPromise = null;
    this._resolveCanvasDataURL = null;

    this.setProps({
      autoResizeViewport,
      autoResizeDrawingBuffer,
      useDevicePixels
    });

    // Bind methods
    this.start = this.start.bind(this);
    this.stop = this.stop.bind(this);

    this._onMousemove = this._onMousemove.bind(this);
    this._onMouseleave = this._onMouseleave.bind(this);
  }

  setNeedsRedraw(reason) {
    assert(typeof reason === 'string');
    this.needsRedraw = this.needsRedraw || reason;
    return this;
  }

  setProps(props) {
    if ('autoResizeViewport' in props) {
      this.autoResizeViewport = props.autoResizeViewport;
    }
    if ('autoResizeDrawingBuffer' in props) {
      this.autoResizeDrawingBuffer = props.autoResizeDrawingBuffer;
    }
    if ('useDevicePixels' in props) {
      this.useDevicePixels = props.useDevicePixels;
    }
    return this;
  }

  // Starts a render loop if not already running
  // @param {Object} context - contains frame specific info (E.g. tick, width, height, etc)
  start(opts = {}) {
    if (this._running) {
      return this;
    }
    this._running = true;
    // console.debug(`Starting ${this.constructor.name}`);
    // Wait for start promise before rendering frame
    getPageLoadPromise()
      .then(() => {
        if (!this._running || this._initialized) {
          return null;
        }

        // Create the WebGL context
        this._createWebGLContext(opts);
        this._createFramebuffer();
        this._startEventHandling();

        // Initialize the callback data
        this._initializeCallbackData();
        this._updateCallbackData();

        // Default viewport setup, in case onInitialize wants to render
        this._resizeCanvasDrawingBuffer();
        this._resizeViewport();

        this._gpuTimeQuery = Query.isSupported(this.gl, ['timers']) ? new Query(this.gl) : null;

        this._initialized = true;

        // Note: onIntialize can return a promise (in case it needs to load resources)
        return this.onInitialize(this.animationProps);
      })
      .then(appContext => {
        if (this._running) {
          this._addCallbackData(appContext || {});
          if (appContext !== false) {
            this._startLoop();
          }
        }
      });
    return this;
  }

  // Redraw now
  redraw() {
    this._beginTimers();

    this._setupFrame();
    this._updateCallbackData();

    // call callback
    this.onRenderFrame(this.animationProps);
    // end callback

    // clear needsRedraw flag
    this._clearNeedsRedraw();

    // https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/commit
    // Chrome's offscreen canvas does not require gl.commit
    if (this.offScreen && this.gl.commit) {
      this.gl.commit();
    }

    if (this._canvasDataURLPromise) {
      this._resolveCanvasDataURL(this.gl.canvas.toDataURL());
      this._canvasDataURLPromise = null;
      this._resolveCanvasDataURL = null;
    }

    this._endTimers();

    return this;
  }

  // Stops a render loop if already running, finalizing
  stop() {
    // console.debug(`Stopping ${this.constructor.name}`);
    if (this._running) {
      this._finalizeCallbackData();
      cancelAnimationFrame(this._animationFrameId);
      this._nextFramePromise = null;
      this._resolveNextFrame = null;
      this._animationFrameId = null;
      this._running = false;
    }
    return this;
  }

  waitForRender() {
    if (!this._nextFramePromise) {
      this._nextFramePromise = new Promise(resolve => {
        this._resolveNextFrame = resolve;
      });
    }
    return this._nextFramePromise;
  }

  toDataURL() {
    if (this._canvasDataURLPromise) {
      return this._canvasDataURLPromise;
    }

    this.setNeedsRedraw('getCanvasDataUrl');
    this._canvasDataURLPromise = new Promise(resolve => {
      this._resolveCanvasDataURL = resolve;
    });

    return this._canvasDataURLPromise;
  }

  onCreateContext(...args) {
    return this.props.onCreateContext(...args);
  }

  onInitialize(...args) {
    return this.props.onInitialize(...args);
  }

  onRenderFrame(...args) {
    if (this.props.onRenderFrame) {
      return this.props.onRenderFrame(...args);
    }

    const opts = args[0];
    const {gl, width, height, _vr: vr} = opts;

    if (vr) {
      vr.display.getFrameData(vr.frameData);

      const {
        leftProjectionMatrix,
        leftViewMatrix,
        rightProjectionMatrix,
        rightViewMatrix
      } = vr.frameData;

      const leftEyeParams = Object.assign({}, opts, {
        vrEye: 'left',
        vrProjectionMatrix: leftProjectionMatrix,
        vrViewMatrix: leftViewMatrix
      });
      withParameters(
        gl,
        {
          viewport: [0, 0, width * 0.5, height],
          scissor: [0, 0, width * 0.5, height],
          scissorTest: true
        },
        () => this.onRender(leftEyeParams)
      );

      const rightEyeParams = Object.assign({}, opts, {
        vrEye: 'right',
        vrProjectionMatrix: rightProjectionMatrix,
        vrViewMatrix: rightViewMatrix
      });
      withParameters(
        gl,
        {
          viewport: [width * 0.5, 0, width * 0.5, height],
          scissor: [width * 0.5, 0, width * 0.5, height],
          scissorTest: true
        },
        () => this.onRender(rightEyeParams)
      );

      vr.display.submitFrame();
    } else {
      gl.viewport(0, 0, width, height);
      this.onRender(opts);
    }

    return true;
  }

  onRender(...args) {
    return this.props.onRender(...args);
  }

  onFinalize(...args) {
    return this.props.onFinalize(...args);
  }

  async enableWebVR() {
    if (!('getVRDisplays' in navigator)) {
      return false;
    }

    const displays = await navigator.getVRDisplays();
    if (displays && displays.length) {
      log.info(2, 'Found VR Displays', displays)();
      // TODO: Consider resizing canvas to match vrDisplay.getEyeParameters()

      this.vrDisplay = displays[0];
      this.vrPresenting = false;
      this.vrButton = createEnterVRButton({
        canvas: this.gl.canvas,
        title: `Enter VR (${this.vrDisplay.displayName})`
      });
      this.vrButton.onclick = () => this.enterWebVR();

      window.addEventListener('vrdisplaypresentchange', () => {
        if (this.vrDisplay.isPresenting) {
          log.info(2, 'Entering VR')();

          this.animationProps._vr = {
            display: this.vrDisplay,
            frameData: new VRFrameData()
          };
          this.vrPresenting = true;
          this.vrButton.style.display = 'none';
        } else {
          log.info(2, 'Exiting VR')();

          this.animationProps._vr = null;
          this.vrPresenting = false;
          this.vrButton.style.display = 'block';
        }
      });

      return true;
    }

    return false;
  }

  enterWebVR() {
    this.vrDisplay.requestPresent([
      {
        source: this.gl.canvas
      }
    ]);
  }

  // DEPRECATED/REMOVED METHODS

  getHTMLControlValue(id, defaultValue = 1) {
    const element = document.getElementById(id);
    return element ? Number(element.value) : defaultValue;
  }

  // Update parameters
  setViewParameters() {
    log.removed('AnimationLoop.setViewParameters', 'AnimationLoop.setProps')();
    return this;
  }

  // PRIVATE METHODS

  _startLoop() {
    const renderFrame = () => {
      if (!this._running) {
        return;
      }
      this.redraw();
      if (this._resolveNextFrame) {
        this._resolveNextFrame(this);
        this._nextFramePromise = null;
        this._resolveNextFrame = null;
      }
      this._animationFrameId = requestAnimationFrame(renderFrame, this._animationFrameDevice());
    };

    // cancel any pending renders to ensure only one loop can ever run
    cancelAnimationFrame(this._animationFrameId);
    this._animationFrameId = requestAnimationFrame(renderFrame, this._animationFrameDevice());
  }

  _animationFrameDevice() {
    return this.vrPresenting ? this.vrDisplay : window;
  }

  _clearNeedsRedraw() {
    this.needsRedraw = null;
  }

  _setupFrame() {
    if (this._onSetupFrame) {
      // call callback
      this._onSetupFrame(this.animationProps);
      // end callback
    } else {
      this._resizeCanvasDrawingBuffer();
      this._resizeViewport();
      this._resizeFramebuffer();
    }
  }

  // Initialize the  object that will be passed to app callbacks
  _initializeCallbackData() {
    this.animationProps = {
      gl: this.gl,

      stop: this.stop,
      canvas: this.gl.canvas,
      framebuffer: this.framebuffer,

      // Initial values
      useDevicePixels: this.useDevicePixels,
      needsRedraw: null,

      // Animation props
      startTime: Date.now(),
      time: 0,
      tick: 0,
      tock: 0,
      // canvas

      // Experimental
      _loop: this,
      _animationLoop: this,
      _mousePosition: null // Event props
    };
  }

  // Update the context object that will be passed to app callbacks
  _updateCallbackData() {
    const {width, height, aspect} = this._getSizeAndAspect();
    if (width !== this.animationProps.width || height !== this.animationProps.height) {
      this.setNeedsRedraw('drawing buffer resized');
    }
    if (aspect !== this.animationProps.aspect) {
      this.setNeedsRedraw('drawing buffer aspect changed');
    }

    this.animationProps.width = width;
    this.animationProps.height = height;
    this.animationProps.aspect = aspect;

    this.animationProps.needsRedraw = this.needsRedraw;

    // Increment tick
    this.animationProps.time = Date.now() - this.animationProps.startTime;
    this.animationProps.tick = Math.floor((this.animationProps.time / 1000) * 60);
    this.animationProps.tock++;

    // experimental
    this.animationProps._offScreen = this.offScreen;
  }

  _finalizeCallbackData() {
    // call callback
    this.onFinalize(this.animationProps);
    // end callback
  }

  // Add application's data to the app context object
  _addCallbackData(appContext) {
    if (typeof appContext === 'object' && appContext !== null) {
      this.animationProps = Object.assign({}, this.animationProps, appContext);
    }
  }

  // Either uses supplied or existing context, or calls provided callback to create one
  _createWebGLContext(opts) {
    this.offScreen =
      opts.canvas &&
      typeof OffscreenCanvas !== 'undefined' &&
      opts.canvas instanceof OffscreenCanvas;

    // Create the WebGL context if necessary
    opts = Object.assign({}, opts, this.props.glOptions);
    this.gl = this.props.gl ? instrumentGLContext(this.props.gl, opts) : this.onCreateContext(opts);

    if (!isWebGL(this.gl)) {
      throw new Error('AnimationLoop.onCreateContext - illegal context returned');
    }

    // Reset the WebGL context.
    resetParameters(this.gl);

    this._createInfoDiv();
  }

  _createInfoDiv() {
    if (this.gl.canvas && this.props.onAddHTML) {
      /* global document */
      const wrapperDiv = document.createElement('div');
      document.body.appendChild(wrapperDiv);
      wrapperDiv.style.position = 'relative';
      const div = document.createElement('div');
      div.style.position = 'absolute';
      div.style.left = '10px';
      div.style.bottom = '10px';
      div.style.width = '300px';
      div.style.background = 'white';
      wrapperDiv.appendChild(this.gl.canvas);
      wrapperDiv.appendChild(div);
      const html = this.props.onAddHTML(div);
      if (html) {
        div.innerHTML = html;
      }
    }
  }

  _getSizeAndAspect() {
    // https://webglfundamentals.org/webgl/lessons/webgl-resizing-the-canvas.html
    const width = this.gl.drawingBufferWidth;
    const height = this.gl.drawingBufferHeight;

    // https://webglfundamentals.org/webgl/lessons/webgl-anti-patterns.html
    let aspect = 1;
    const {clientWidth, clientHeight} = this.gl.canvas;
    if (clientWidth >= 0 && clientHeight >= 0) {
      aspect = height > 0 ? clientWidth / clientHeight : 1;
    } else if (width > 0 && height > 0) {
      aspect = width / height;
    }

    return {width, height, aspect};
  }

  // Default viewport setup
  _resizeViewport() {
    if (this.autoResizeViewport) {
      this.gl.viewport(0, 0, this.gl.drawingBufferWidth, this.gl.drawingBufferHeight);
    }
  }

  // Resize the render buffer of the canvas to match canvas client size
  // Optionally multiplying with devicePixel ratio
  _resizeCanvasDrawingBuffer() {
    if (this.autoResizeDrawingBuffer) {
      resizeGLContext(this.gl, {useDevicePixels: this.useDevicePixels});
    }
  }

  // TBD - deprecated?
  _createFramebuffer() {
    // Setup default framebuffer
    if (this.props.createFramebuffer) {
      this.framebuffer = new Framebuffer(this.gl);
    }
  }

  _resizeFramebuffer() {
    if (this.framebuffer) {
      this.framebuffer.resize({
        width: this.gl.drawingBufferWidth,
        height: this.gl.drawingBufferHeight
      });
    }
  }

  _beginTimers() {
    this.frameRate.timeEnd();
    this.frameRate.timeStart();

    // Check if timer for last frame has completed.
    // GPU timer results are never available in the same
    // frame they are captured.
    if (
      this._gpuTimeQuery &&
      this._gpuTimeQuery.isResultAvailable() &&
      !this._gpuTimeQuery.isTimerDisjoint()
    ) {
      this.stats.get('GPU Time').addTime(this._gpuTimeQuery.getTimerMilliseconds());
    }

    if (this._gpuTimeQuery) {
      // GPU time query start
      this._gpuTimeQuery.beginTimeElapsedQuery();
    }

    this.cpuTime.timeStart();
  }

  _endTimers() {
    this.cpuTime.timeEnd();

    if (this._gpuTimeQuery) {
      // GPU time query end. Results will be available on next frame.
      this._gpuTimeQuery.end();
    }
  }

  // Event handling

  _startEventHandling() {
    this.gl.canvas.addEventListener('mousemove', this._onMousemove);
    this.gl.canvas.addEventListener('mouseleave', this._onMouseleave);
  }

  _onMousemove(e) {
    this.animationProps._mousePosition = [e.offsetX, e.offsetY];
  }
  _onMouseleave(e) {
    this.animationProps._mousePosition = null;
  }
}
