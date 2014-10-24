/**
 * Copyright 2014 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

module Shumway.GFX {
  import Point = Geometry.Point;
  import Rectangle = Geometry.Rectangle;
  import PathCommand = Shumway.PathCommand;
  import Matrix = Geometry.Matrix;
  import DataBuffer = Shumway.ArrayUtilities.DataBuffer;
  import swap32 = Shumway.IntegerUtilities.swap32;
  import memorySizeToString = Shumway.StringUtilities.memorySizeToString;
  import assertUnreachable = Shumway.Debug.assertUnreachable;
  import unpremultiplyARGB = Shumway.ColorUtilities.unpremultiplyARGB;
  import tableLookupUnpremultiplyARGB = Shumway.ColorUtilities.tableLookupUnpremultiplyARGB;
  import assert = Shumway.Debug.assert;
  import unexpected = Shumway.Debug.unexpected;
  import notImplemented = Shumway.Debug.notImplemented;
  import pushUnique = Shumway.ArrayUtilities.pushUnique;
  import indexOf = Shumway.ArrayUtilities.indexOf;
  import VideoPlaybackEvent = Shumway.Remoting.VideoPlaybackEvent;
  import VideoControlEvent = Shumway.Remoting.VideoControlEvent;

  export enum RenderableFlags {
    None          = 0,

    /**
     * Whether source has dynamic content.
     */
    Dynamic       = 1,

    /**
     * Whether the source's dynamic content has changed. This is only defined if |isDynamic| is true.
     */
    Dirty         = 2,

    /**
     * Whether the source's content can be scaled and drawn at a higher resolution.
     */
    Scalable      = 4,

    /**
     * Whether the source's content should be tiled.
     */
    Tileable      = 8,

    /**
     * Whether the source's content is loading and thus not available yet. Once loading
     * is complete this flag is cleared and the |Dirty| flag is set.
     */
    Loading  = 16
  }

  /**
   * Represents some source renderable content.
   */
  export class Renderable {
    /**
     * Flags
     */
    _flags: RenderableFlags = RenderableFlags.None;

    setFlags(flags: RenderableFlags) {
      this._flags |= flags;
    }

    hasFlags(flags: RenderableFlags): boolean {
      return (this._flags & flags) === flags;
    }

    removeFlags(flags: RenderableFlags) {
      this._flags &= ~flags;
    }

    /**
     * Property bag used to attach dynamic properties to this object.
     */
    properties: {[name: string]: any} = {};

    /**
     * Back reference to frames that use this renderable.
     */
    private _nodeReferrers: Node [] = [];

    /**
     * Back reference to renderables that use this renderable.
     */
    private _renderableReferrers: Renderable [] = [];

    public addNodeReferrer(frame: Node) {
      release && assert(frame);
      var index = indexOf(this._nodeReferrers, frame);
      release && assert(index < 0);
      this._nodeReferrers.push(frame);
    }

    public addRenderableReferrer(renderable: Renderable) {
      release && assert(renderable);
      var index = indexOf(this._renderableReferrers, renderable);
      release && assert(index < 0);
      this._renderableReferrers.push(renderable);
    }

    public invalidatePaint() {
      this.setFlags(RenderableFlags.Dirty);
      var frames = this._nodeReferrers;
      for (var i = 0; i < frames.length; i++) {
        frames[i].invalidatePaint();
      }
      var renderables = this._renderableReferrers;
      for (var i = 0; i < renderables.length; i++) {
        renderables[i].invalidatePaint();
      }
      var listeners = this._invalidatePaintEventListeners;
      if (listeners) {
        for (var i = 0; i < listeners.length; i++) {
          listeners[i](this);
        }
      }
    }

    private _invalidatePaintEventListeners: {(renderable: Renderable): void} [] = null;

    public addInvalidatePaintEventListener(listener: (renderable: Renderable) => void) {
      if (!this._invalidatePaintEventListeners) {
        this._invalidatePaintEventListeners = [];
      }
      var index = indexOf(this._invalidatePaintEventListeners, listener);
      release && assert(index < 0);
      this._invalidatePaintEventListeners.push(listener);
    }

    _bounds: Rectangle;

    constructor(bounds: Rectangle) {
      this._bounds = bounds.clone();
    }

    /**
     * Bounds of the source content. This should never change.
     */
    getBounds (): Rectangle {
      return this._bounds;
    }

    /**
     * Render source content in the specified |context|. If specified, the rectangular |cullBounds| can be used to cull parts of the shape
     * for better performance. If specified, |Region| indicates whether the shape's fills should be used as clip regions instead.
     */
    render(context: CanvasRenderingContext2D, ratio: number, cullBounds?: Shumway.GFX.Geometry.Rectangle, paintClip?: boolean, paintpaintStencil?: boolean): void {

    }
  }

  export class CustomRenderable extends Renderable {
    constructor(bounds: Rectangle, render: (context: CanvasRenderingContext2D, ratio: number, cullBounds: Shumway.GFX.Geometry.Rectangle) => void) {
      super(bounds);
      this.render = render;
    }
  }

  export interface IVideoPlaybackEventSerializer {
    sendVideoPlaybackEvent(assetId: number, eventType: VideoPlaybackEvent, data: any): void;
  }

  export class RenderableVideo extends Renderable {
    _flags = RenderableFlags.Dynamic | RenderableFlags.Dirty;
    private _video: HTMLVideoElement;
    private _videoEventHandler: (e:Event)=>void;
    private _assetId: number;
    private _eventSerializer: IVideoPlaybackEventSerializer;
    private _lastCurrentTime: number = 0;
    static _renderableVideos: RenderableVideo [] = [];

    constructor(url: string, bounds: Rectangle, assetId: number, eventSerializer: IVideoPlaybackEventSerializer) {
      super(bounds);

      this._assetId = assetId;
      this._eventSerializer = eventSerializer;

      var element: HTMLVideoElement = document.createElement('video');
      var elementEventHandler = this._handleVideoEvent.bind(this);
      element.preload = 'metadata'; // for mobile devices
      element.src = url;
      // element.loop = true;
      element.addEventListener("play", elementEventHandler);
      element.addEventListener("ended", elementEventHandler);
      element.addEventListener("loadeddata", elementEventHandler);
      element.addEventListener("progress", elementEventHandler);
      element.addEventListener("waiting", elementEventHandler);
      element.addEventListener("loadedmetadata", elementEventHandler);
      element.addEventListener("error", elementEventHandler);
      element.play();

      this._video = element;
      this._videoEventHandler = elementEventHandler;

      RenderableVideo._renderableVideos.push(this);

      this._notifyNetStream(VideoPlaybackEvent.Initialized, null);
    }

    private _handleVideoEvent(evt: Event) {
      var type: VideoPlaybackEvent;
      var data: any = null;
      var element: HTMLVideoElement = this._video;
      switch (evt.type) {
        case "play":
          type = VideoPlaybackEvent.PlayStart;
          break;
        case "ended":
          type = VideoPlaybackEvent.PlayStop;
          break;
        case "loadeddata":
          type = VideoPlaybackEvent.BufferFull;
          break;
        case "progress":
          type = VideoPlaybackEvent.Progress;
          break;
        case "waiting":
          type = VideoPlaybackEvent.BufferEmpty;
          break;
        case "loadedmetadata":
          type = VideoPlaybackEvent.Metadata;
          data = {
            videoWidth: element.videoWidth,
            videoHeight: element.videoHeight,
            duration: element.duration
          };
          break;
        case "error":
          type = VideoPlaybackEvent.Error;
          data = {
            code: element.error.code
          };
          break;
        default:
          return; // unhandled event
      }
      this._notifyNetStream(type, data);
    }

    private _notifyNetStream(eventType: VideoPlaybackEvent, data: any): void {
      this._eventSerializer.sendVideoPlaybackEvent(this._assetId, eventType, data);
    }

    processControlRequest(type: VideoControlEvent, data: any): any {
      var videoElement = this._video;
      switch (type) {
        case VideoControlEvent.Pause:
          if (videoElement) {
            if (data.paused && !videoElement.paused) {
              videoElement.pause();
            } else if (!data.paused && videoElement.paused) {
              videoElement.play();
            }
            if (!isNaN(data.time)) {
              videoElement.currentTime = data.time;
            }
          }
          return;
        case VideoControlEvent.Seek:
          if (videoElement && !videoElement.paused) {
            videoElement.currentTime = data.time;
          }
          return;
        case VideoControlEvent.GetTime:
          return videoElement ? videoElement.currentTime : 0;
        case VideoControlEvent.GetBufferLength:
          return videoElement ? videoElement.duration : 0;
      }
    }

    public invalidatePaintCheck() {
      if (this._lastCurrentTime !== this._video.currentTime) {
        this.invalidatePaint();
      }
      this._lastCurrentTime = this._video.currentTime;
    }

    public static invalidateVideos() {
      var renderables = RenderableVideo._renderableVideos;
      for (var i = 0; i < renderables.length; i++) {
        renderables[i].invalidatePaintCheck();
      }
    }

    render(context: CanvasRenderingContext2D, ratio: number, cullBounds: Rectangle): void {
      enterTimeline("RenderableVideo.render");
      var videoElement = this._video;
      if (videoElement && videoElement.videoWidth > 0) {
        context.drawImage(videoElement,
          0, 0, videoElement.videoWidth, videoElement.videoHeight,
          0, 0, this._bounds.w, this._bounds.h);
      }
      leaveTimeline("RenderableVideo.render");
    }
  }

  export class RenderableBitmap extends Renderable {
    _flags = RenderableFlags.Dynamic | RenderableFlags.Dirty;
    properties: {[name: string]: any} = {};
    _canvas: HTMLCanvasElement;
    _context: CanvasRenderingContext2D;
    _imageData: ImageData;
    private fillStyle: ColorStyle;

    public static FromDataBuffer(type: ImageType, dataBuffer: DataBuffer, bounds: Rectangle): RenderableBitmap {
      enterTimeline("RenderableBitmap.FromDataBuffer");
      var canvas = document.createElement("canvas");
      canvas.width = bounds.w;
      canvas.height = bounds.h;
      var renderableBitmap = new RenderableBitmap(canvas, bounds);
      renderableBitmap.updateFromDataBuffer(type, dataBuffer);
      leaveTimeline("RenderableBitmap.FromDataBuffer");
      return renderableBitmap;
    }

    public static FromNode(source: Node, matrix: Shumway.GFX.Geometry.Matrix, colorMatrix: Shumway.GFX.ColorMatrix, blendMode: number, clipRect: Rectangle) {
      enterTimeline("RenderableBitmap.FromFrame");
      var canvas = document.createElement("canvas");
      var bounds = source.getBounds();
      canvas.width = bounds.w;
      canvas.height = bounds.h;
      var renderableBitmap = new RenderableBitmap(canvas, bounds);
      renderableBitmap.drawNode(source, matrix, colorMatrix, blendMode, clipRect);
      leaveTimeline("RenderableBitmap.FromFrame");
      return renderableBitmap;
    }

    public updateFromDataBuffer(type: ImageType, dataBuffer: DataBuffer) {
      if (!imageUpdateOption.value) {
        return;
      }
      enterTimeline("RenderableBitmap.updateFromDataBuffer", {length: dataBuffer.length});
      if (type === ImageType.JPEG ||
          type === ImageType.PNG  ||
          type === ImageType.GIF)
      {
        var self = this;
        self.setFlags(RenderableFlags.Loading);
        var image = new Image();
        image.src = URL.createObjectURL(dataBuffer.toBlob());
        image.onload = function () {
          self._context.drawImage(image, 0, 0);
          self.removeFlags(RenderableFlags.Loading);
          self.invalidatePaint();
        };
        image.onerror = function () {
          unexpected("Image loading error: " + ImageType[type]);
        };
      } else {
        if (imageConvertOption.value) {
          enterTimeline("ColorUtilities.convertImage");
          ColorUtilities.convertImage (
            type,
            ImageType.StraightAlphaRGBA,
            new Int32Array(dataBuffer.buffer),
            new Int32Array(this._imageData.data.buffer)
          );
          leaveTimeline("ColorUtilities.convertImage");
        }
        enterTimeline("putImageData");
        this._context.putImageData(this._imageData, 0, 0);
        leaveTimeline("putImageData");
      }
      this.invalidatePaint();
      leaveTimeline("RenderableBitmap.updateFromDataBuffer");
    }

    /**
     * Writes the image data into the given |output| data buffer.
     */
    public readImageData(output: DataBuffer) {
      var data = <Uint8Array>this._context.getImageData(0, 0, this._canvas.width, this._canvas.height).data;
      output.writeRawBytes(data);
    }

    constructor(canvas: HTMLCanvasElement, bounds: Rectangle) {
      super(bounds);
      this._canvas = canvas;
      this._context = this._canvas.getContext("2d");
      this._imageData = this._context.createImageData(this._bounds.w, this._bounds.h);
    }

    render(context: CanvasRenderingContext2D, ratio: number, cullBounds: Rectangle): void {
      enterTimeline("RenderableBitmap.render");
      if (this._canvas) {
        context.drawImage(this._canvas, 0, 0);
      } else {
        this._renderFallback(context);
      }
      leaveTimeline("RenderableBitmap.render");
    }

    drawNode(source: Node, matrix: Shumway.GFX.Geometry.Matrix, colorMatrix: Shumway.GFX.ColorMatrix, blendMode: number, clip: Rectangle): void {
      // TODO: Support colorMatrix and blendMode.
      enterTimeline("RenderableBitmap.drawFrame");
      // TODO: Hack to be able to compile this as part of gfx-base.
      var Canvas2D = (<any>GFX).Canvas2D;
      var bounds = this.getBounds();
      var options = new Canvas2D.Canvas2DStageRendererOptions();
      var renderer = new Canvas2D.Canvas2DStageRenderer(this._canvas, null, options);
      renderer.renderNode(source, clip || bounds, matrix);
      leaveTimeline("RenderableBitmap.drawFrame");
    }

    private _renderFallback(context: CanvasRenderingContext2D) {
      if (!this.fillStyle) {
        this.fillStyle = Shumway.ColorStyle.randomStyle();
      }
      var bounds = this._bounds;
      context.save();
      context.beginPath();
      context.lineWidth = 2;
      context.fillStyle = this.fillStyle;
      context.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
      context.restore();
    }
  }

  export enum PathType {
    Fill,
    Stroke,
    StrokeFill /* Doesn't define thickness, caps and joints. */
  }

  export class StyledPath {
    path: Path2D;
    constructor(public type: PathType, public style: any, public smoothImage: boolean,
                public strokeProperties: StrokeProperties)
    {
      this.path = new Path2D();
      release || assert ((type === PathType.Stroke) === !!strokeProperties);
    }
  }

  export class StrokeProperties {
    constructor(public thickness: number, public scaleMode: LineScaleMode,
                public capsStyle: string, public jointsStyle: string,
                public miterLimit: number)
    {}
  }

  function morph(start: number, end: number, ratio: number): number {
    return start + (end - start) * ratio;
  }

  function morphColor(start: number, end: number, ratio: number): number {
    return morph(start >> 24 & 0xff, end >> 24 & 0xff, ratio) << 24 |
           morph(start >> 16 & 0xff, end >> 16 & 0xff, ratio) << 16 |
           morph(start >> 8 & 0xff, end >> 8 & 0xff, ratio) << 8 |
           morph(start & 0xff, end & 0xff, ratio);
  }

  export class RenderableShape extends Renderable {
    _flags: RenderableFlags = RenderableFlags.Dirty     |
                              RenderableFlags.Scalable  |
                              RenderableFlags.Tileable;
    properties: {[name: string]: any} = {};

    private fillStyle: ColorStyle;
    private _paths: StyledPath[];

    protected _id: number;
    protected _pathData: ShapeData;
    protected _textures: RenderableBitmap[];

    protected static LINE_CAPS_STYLES = ['round', 'butt', 'square'];
    protected static LINE_JOINTS_STYLES = ['round', 'bevel', 'miter'];

    constructor(id: number, pathData: ShapeData, textures: RenderableBitmap[], bounds: Rectangle) {
      super(bounds);
      this._id = id;
      this._pathData = pathData;
      this._textures = textures;
      if (textures.length) {
        this.setFlags(RenderableFlags.Dynamic);
      }
    }

    update(pathData: ShapeData, textures: RenderableBitmap[], bounds: Rectangle) {
      this._bounds = bounds;
      this._pathData = pathData;
      this._paths = null;
      this._textures = textures;
      this.invalidatePaint();
    }

    getBounds(): Shumway.GFX.Geometry.Rectangle {
      return this._bounds;
    }

    /**
     * If |paintClip| is |true| then we must call |clip| instead of |fill|. We also cannot call
     * |save| or |restore| because those functions reset the current clipping region. It looks
     * like Flash ignores strokes when clipping so we can also ignore stroke paths when computing
     * the clip region.
     *
     * If |paintStencil| is |true| then we most not create any alpha values, and also not paint any strokes.
     */
    render(context: CanvasRenderingContext2D, ratio: number, cullBounds: Rectangle,
           paintClip: boolean = false, paintStencil: boolean = false): void
    {
      var paintStencilStyle = '#FF4981';
      context.fillStyle = context.strokeStyle = 'transparent';

      // Wait to deserialize paths until all textures have been loaded.
      var textures = this._textures;
      for (var i = 0; i < textures.length; i++) {
        if (textures[i].hasFlags(RenderableFlags.Loading)) {
          return;
        }
      }

      var paths = this._deserializePaths(this._pathData, context, ratio);
      release || assert(paths);

      enterTimeline("RenderableShape.render", this);
      for (var i = 0; i < paths.length; i++) {
        var path = paths[i];
        context['mozImageSmoothingEnabled'] = context.msImageSmoothingEnabled =
                                              context['imageSmoothingEnabled'] =
                                              path.smoothImage;
        if (path.type === PathType.Fill) {
          context.fillStyle = paintStencil ? paintStencilStyle : path.style;
          paintClip ? context.clip(path.path, 'evenodd') : context.fill(path.path, 'evenodd');
          context.fillStyle = 'transparent';
        } else if (!paintClip && !paintStencil) {
          context.strokeStyle = path.style;
          var lineScaleMode = LineScaleMode.Normal;
          if (path.strokeProperties) {
            lineScaleMode = path.strokeProperties.scaleMode;
            context.lineWidth = path.strokeProperties.thickness;
            context.lineCap = path.strokeProperties.capsStyle;
            context.lineJoin = path.strokeProperties.jointsStyle;
            context.miterLimit = path.strokeProperties.miterLimit;
          }
          // Special-cases 1px and 3px lines by moving the drawing position down/right by 0.5px.
          // Flash apparently does this to create sharp, non-aliased lines in the normal case of thin
          // lines drawn on round pixel values.
          // Our handling doesn't always create the same results: for drawing coordinates with
          // fractional values, Flash draws blurry lines. We do, too, but we still move the line
          // down/right. Flash does something slightly different, with the result that a line drawn
          // on coordinates slightly below round pixels (0.8, say) will be moved up/left.
          // Properly fixing this would probably have to happen in the rasterizer. Or when replaying
          // all the drawing commands, which seems expensive.
          var lineWidth = context.lineWidth;
          var isSpecialCaseWidth = lineWidth === 1 || lineWidth === 3;
          if (isSpecialCaseWidth) {
            context.translate(0.5, 0.5);
          }
          context.flashStroke(path.path, lineScaleMode);
          if (isSpecialCaseWidth) {
            context.translate(-0.5, -0.5);
          }
          context.strokeStyle = 'transparent';
        }
      }
      leaveTimeline("RenderableShape.render");
    }

    protected _deserializePaths(data: ShapeData, context: CanvasRenderingContext2D, ratio: number): StyledPath[] {
      release || assert(data ? !this._paths : this._paths);
      enterTimeline("RenderableShape.deserializePaths");
      // TODO: Optimize path handling to use only one path if possible.
      // If both line and fill style are set at the same time, we don't need to duplicate the
      // geometry.

      if (this._paths) {
        return this._paths;
      }

      var paths = this._paths = [];

      var fillPath: Path2D = null;
      var strokePath: Path2D = null;

      // We have to alway store the last position because Flash keeps the drawing cursor where it
      // was when changing fill or line style, whereas Canvas forgets it on beginning a new path.
      var x = 0;
      var y = 0;
      var cpX: number;
      var cpY: number;
      var formOpen = false;
      var formOpenX = 0;
      var formOpenY = 0;
      var commands = data.commands;
      var coordinates = data.coordinates;
      var styles = data.styles;
      styles.position = 0;
      var coordinatesIndex = 0;
      var commandsCount = data.commandsPosition;
      // Description of serialization format can be found in flash.display.Graphics.
      for (var commandIndex = 0; commandIndex < commandsCount; commandIndex++) {
        var command = commands[commandIndex];
        switch (command) {
          case PathCommand.MoveTo:
            release || assert(coordinatesIndex <= data.coordinatesPosition - 2);
            if (formOpen && fillPath) {
              fillPath.lineTo(formOpenX, formOpenY);
              strokePath && strokePath.lineTo(formOpenX, formOpenY);
            }
            formOpen = true;
            x = formOpenX = coordinates[coordinatesIndex++] / 20;
            y = formOpenY = coordinates[coordinatesIndex++] / 20;
            fillPath && fillPath.moveTo(x, y);
            strokePath && strokePath.moveTo(x, y);
            break;
          case PathCommand.LineTo:
            release || assert(coordinatesIndex <= data.coordinatesPosition - 2);
            x = coordinates[coordinatesIndex++] / 20;
            y = coordinates[coordinatesIndex++] / 20;
            fillPath && fillPath.lineTo(x, y);
            strokePath && strokePath.lineTo(x, y);
            break;
          case PathCommand.CurveTo:
            release || assert(coordinatesIndex <= data.coordinatesPosition - 4);
            cpX = coordinates[coordinatesIndex++] / 20;
            cpY = coordinates[coordinatesIndex++] / 20;
            x = coordinates[coordinatesIndex++] / 20;
            y = coordinates[coordinatesIndex++] / 20;
            fillPath && fillPath.quadraticCurveTo(cpX, cpY, x, y);
            strokePath && strokePath.quadraticCurveTo(cpX, cpY, x, y);
            break;
          case PathCommand.CubicCurveTo:
            release || assert(coordinatesIndex <= data.coordinatesPosition - 6);
            cpX = coordinates[coordinatesIndex++] / 20;
            cpY = coordinates[coordinatesIndex++] / 20;
            var cpX2 = coordinates[coordinatesIndex++] / 20;
            var cpY2 = coordinates[coordinatesIndex++] / 20;
            x = coordinates[coordinatesIndex++] / 20;
            y = coordinates[coordinatesIndex++] / 20;
            fillPath && fillPath.bezierCurveTo(cpX, cpY, cpX2, cpY2, x, y);
            strokePath && strokePath.bezierCurveTo(cpX, cpY, cpX2, cpY2, x, y);
            break;
          case PathCommand.BeginSolidFill:
            release || assert(styles.bytesAvailable >= 4);
            fillPath = this._createPath(PathType.Fill,
                                        ColorUtilities.rgbaToCSSStyle(styles.readUnsignedInt()),
                                        false, null, x, y);
            break;
          case PathCommand.BeginBitmapFill:
            var bitmapStyle = this._readBitmap(styles, context);
            fillPath = this._createPath(PathType.Fill, bitmapStyle.style, bitmapStyle.smoothImage,
                                        null, x, y);
            break;
          case PathCommand.BeginGradientFill:
            fillPath = this._createPath(PathType.Fill, this._readGradient(styles, context),
                                        false, null, x, y);
            break;
          case PathCommand.EndFill:
            fillPath = null;
            break;
          case PathCommand.LineStyleSolid:
            var color = ColorUtilities.rgbaToCSSStyle(styles.readUnsignedInt());
            // Skip pixel hinting.
            styles.position += 1;
            var scaleMode: LineScaleMode = styles.readByte();
            var capsStyle: string = RenderableShape.LINE_CAPS_STYLES[styles.readByte()];
            var jointsStyle: string = RenderableShape.LINE_JOINTS_STYLES[styles.readByte()];
            var strokeProperties = new StrokeProperties(coordinates[coordinatesIndex++]/20,
                                                        scaleMode, capsStyle, jointsStyle, styles.readByte());
            strokePath = this._createPath(PathType.Stroke, color, false, strokeProperties, x, y);
            break;
          case PathCommand.LineStyleGradient:
            strokePath = this._createPath(PathType.StrokeFill, this._readGradient(styles, context),
                                          false, null, x, y);
            break;
          case PathCommand.LineStyleBitmap:
            var bitmapStyle = this._readBitmap(styles, context);
            strokePath = this._createPath(PathType.StrokeFill, bitmapStyle.style,
                                          bitmapStyle.smoothImage, null, x, y);
            break;
          case PathCommand.LineEnd:
            strokePath = null;
            break;
          default:
            release || assertUnreachable('Invalid command ' + command + ' encountered at index' +
                                         commandIndex + ' of ' + commandsCount);
        }
      }
      release || assert(styles.bytesAvailable === 0);
      release || assert(commandIndex === commandsCount);
      release || assert(coordinatesIndex === data.coordinatesPosition);
      if (formOpen && fillPath) {
        fillPath.lineTo(formOpenX, formOpenY);
        strokePath && strokePath.lineTo(formOpenX, formOpenY);
      }
      this._pathData = null;
      leaveTimeline("RenderableShape.deserializePaths");

      return paths;
    }

    private _createPath(type: PathType, style: any, smoothImage: boolean,
                        strokeProperties: StrokeProperties, x: number, y: number): Path2D
    {
      var path = new StyledPath(type, style, smoothImage, strokeProperties);
      this._paths.push(path);
      path.path.moveTo(x, y);
      return path.path;
    }

    private _readMatrix(data: DataBuffer): Matrix {
      return new Matrix (
        data.readFloat(), data.readFloat(), data.readFloat(),
        data.readFloat(), data.readFloat(), data.readFloat()
      );
    }

    private _readGradient(styles: DataBuffer, context: CanvasRenderingContext2D): CanvasGradient {
      // Assert at least one color stop.
      release || assert(styles.bytesAvailable >= 1 + 1 + 6 * 4 /* matrix fields as floats */ +
                                                 1 + 1 + 4 + 1 + 1);
      var gradientType = styles.readUnsignedByte();
      var focalPoint = styles.readShort() * 2 / 0xff;
      release || assert(focalPoint >= -1 && focalPoint <= 1);
      var transform = this._readMatrix(styles);
      var gradient = gradientType === GradientType.Linear ?
                     context.createLinearGradient(-1, 0, 1, 0) :
                     context.createRadialGradient(focalPoint, 0, 0, 0, 0, 1);
      gradient.setTransform && gradient.setTransform(transform.toSVGMatrix());
      var colorStopsCount = styles.readUnsignedByte();
      for (var i = 0; i < colorStopsCount; i++) {
        var ratio = styles.readUnsignedByte() / 0xff;
        var cssColor = ColorUtilities.rgbaToCSSStyle(styles.readUnsignedInt());
        gradient.addColorStop(ratio, cssColor);
      }

      // Skip spread and interpolation modes for now.
      styles.position += 2;

      return gradient;
    }

    private _readBitmap(styles: DataBuffer,
                        context: CanvasRenderingContext2D): {style: CanvasPattern;
                                                             smoothImage: boolean}
    {
      release || assert(styles.bytesAvailable >= 4 + 6 * 4 /* matrix fields as floats */ + 1 + 1);
      var textureIndex = styles.readUnsignedInt();
      var fillTransform: Matrix = this._readMatrix(styles);
      var repeat = styles.readBoolean() ? 'repeat' : 'no-repeat';
      var smooth = styles.readBoolean();
      var texture = this._textures[textureIndex];
      release || assert(texture._canvas);
      var fillStyle: CanvasPattern = context.createPattern(texture._canvas, repeat);
      fillStyle.setTransform(fillTransform.toSVGMatrix());
      return {style: fillStyle, smoothImage: smooth};
    }

    protected _renderFallback(context: CanvasRenderingContext2D) {
      if (!this.fillStyle) {
        this.fillStyle = Shumway.ColorStyle.randomStyle();
      }
      var bounds = this._bounds;
      context.save();
      context.beginPath();
      context.lineWidth = 2;
      context.fillStyle = this.fillStyle;
      context.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
//      context.textBaseline = "top";
//      context.fillStyle = "white";
//      context.fillText(String(id), bounds.x, bounds.y);
      context.restore();
    }

  }

  export class RenderableMorphShape extends RenderableShape {
    _flags: RenderableFlags = RenderableFlags.Dynamic   |
                              RenderableFlags.Dirty     |
                              RenderableFlags.Scalable  |
                              RenderableFlags.Tileable;

    private _morphPaths: { [key: number]: StyledPath[] } = Object.create(null);

    protected _deserializePaths(data: ShapeData, context: CanvasRenderingContext2D, ratio: number): StyledPath[] {
      enterTimeline("RenderableMorphShape.deserializePaths");
      // TODO: Optimize path handling to use only one path if possible.
      // If both line and fill style are set at the same time, we don't need to duplicate the
      // geometry.

      if (this._morphPaths[ratio]) {
        return this._morphPaths[ratio];
      }

      var paths = this._morphPaths[ratio] = [];

      var fillPath: Path2D = null;
      var strokePath: Path2D = null;

      // We have to alway store the last position because Flash keeps the drawing cursor where it
      // was when changing fill or line style, whereas Canvas forgets it on beginning a new path.
      var x = 0;
      var y = 0;
      var cpX: number;
      var cpY: number;
      var formOpen = false;
      var formOpenX = 0;
      var formOpenY = 0;
      var commands = data.commands;
      var coordinates = data.coordinates;
      var morphCoordinates = data.morphCoordinates;
      var styles = data.styles;
      var morphStyles = data.morphStyles;
      styles.position = 0;
      morphStyles.position = 0;
      var coordinatesIndex = 0;
      var commandsCount = data.commandsPosition;
      // Description of serialization format can be found in flash.display.Graphics.
      for (var commandIndex = 0; commandIndex < commandsCount; commandIndex++) {
        var command = commands[commandIndex];
        switch (command) {
          case PathCommand.MoveTo:
            release || assert(coordinatesIndex <= data.coordinatesPosition - 2);
            if (formOpen && fillPath) {
              fillPath.lineTo(formOpenX, formOpenY);
              strokePath && strokePath.lineTo(formOpenX, formOpenY);
            }
            formOpen = true;
            x = formOpenX = morph(coordinates[coordinatesIndex],
              morphCoordinates[coordinatesIndex++], ratio) / 20;
            y = formOpenY = morph(coordinates[coordinatesIndex],
              morphCoordinates[coordinatesIndex++], ratio) / 20;
            fillPath && fillPath.moveTo(x, y);
            strokePath && strokePath.moveTo(x, y);
            break;
          case PathCommand.LineTo:
            release || assert(coordinatesIndex <= data.coordinatesPosition - 2);
            x = morph(coordinates[coordinatesIndex],
              morphCoordinates[coordinatesIndex++], ratio) / 20;
            y = morph(coordinates[coordinatesIndex],
              morphCoordinates[coordinatesIndex++], ratio) / 20;
            fillPath && fillPath.lineTo(x, y);
            strokePath && strokePath.lineTo(x, y);
            break;
          case PathCommand.CurveTo:
            release || assert(coordinatesIndex <= data.coordinatesPosition - 4);
            cpX = morph(coordinates[coordinatesIndex],
              morphCoordinates[coordinatesIndex++], ratio) / 20;
            cpY = morph(coordinates[coordinatesIndex],
              morphCoordinates[coordinatesIndex++], ratio) / 20;
            x = morph(coordinates[coordinatesIndex],
              morphCoordinates[coordinatesIndex++], ratio) / 20;
            y = morph(coordinates[coordinatesIndex],
              morphCoordinates[coordinatesIndex++], ratio) / 20;
            fillPath && fillPath.quadraticCurveTo(cpX, cpY, x, y);
            strokePath && strokePath.quadraticCurveTo(cpX, cpY, x, y);
            break;
          case PathCommand.CubicCurveTo:
            release || assert(coordinatesIndex <= data.coordinatesPosition - 6);
            cpX = morph(coordinates[coordinatesIndex],
              morphCoordinates[coordinatesIndex++], ratio) / 20;
            cpY = morph(coordinates[coordinatesIndex],
              morphCoordinates[coordinatesIndex++], ratio) / 20;
            var cpX2 = morph(coordinates[coordinatesIndex],
              morphCoordinates[coordinatesIndex++], ratio) / 20;
            var cpY2 = morph(coordinates[coordinatesIndex],
              morphCoordinates[coordinatesIndex++], ratio) / 20;
            x = morph(coordinates[coordinatesIndex],
              morphCoordinates[coordinatesIndex++], ratio) / 20;
            y = morph(coordinates[coordinatesIndex],
              morphCoordinates[coordinatesIndex++], ratio) / 20;
            fillPath && fillPath.bezierCurveTo(cpX, cpY, cpX2, cpY2, x, y);
            strokePath && strokePath.bezierCurveTo(cpX, cpY, cpX2, cpY2, x, y);
            break;
          case PathCommand.BeginSolidFill:
            release || assert(styles.bytesAvailable >= 4);
            fillPath = this._createMorphPath(PathType.Fill, ratio,
              ColorUtilities.rgbaToCSSStyle(
                morphColor(styles.readUnsignedInt(), morphStyles.readUnsignedInt(), ratio)
              ),
              false, null, x, y);
            break;
          case PathCommand.BeginBitmapFill:
            var bitmapStyle = this._readMorphBitmap(styles, morphStyles, ratio, context);
            fillPath = this._createMorphPath(PathType.Fill, ratio, bitmapStyle.style, bitmapStyle.smoothImage,
              null, x, y);
            break;
          case PathCommand.BeginGradientFill:
            var gradientStyle = this._readMorphGradient(styles, morphStyles, ratio, context);
            fillPath = this._createMorphPath(PathType.Fill, ratio, gradientStyle,
              false, null, x, y);
            break;
          case PathCommand.EndFill:
            fillPath = null;
            break;
          case PathCommand.LineStyleSolid:
            var width = morph(coordinates[coordinatesIndex],
              morphCoordinates[coordinatesIndex++], ratio) / 20;
            var color = ColorUtilities.rgbaToCSSStyle(
              morphColor(styles.readUnsignedInt(), morphStyles.readUnsignedInt(), ratio)
            );
            // Skip pixel hinting.
            styles.position += 1;
            var scaleMode: LineScaleMode = styles.readByte();
            var capsStyle: string = RenderableShape.LINE_CAPS_STYLES[styles.readByte()];
            var jointsStyle: string = RenderableShape.LINE_JOINTS_STYLES[styles.readByte()];
            var strokeProperties = new StrokeProperties(
              width, scaleMode, capsStyle, jointsStyle, styles.readByte());
            strokePath = this._createMorphPath(PathType.Stroke, ratio, color, false, strokeProperties, x, y);
            break;
          case PathCommand.LineStyleGradient:
            var gradientStyle = this._readMorphGradient(styles, morphStyles, ratio, context);
            strokePath = this._createMorphPath(PathType.StrokeFill, ratio, gradientStyle,
              false, null, x, y);
            break;
          case PathCommand.LineStyleBitmap:
            var bitmapStyle = this._readMorphBitmap(styles, morphStyles, ratio, context);
            strokePath = this._createMorphPath(PathType.StrokeFill, ratio, bitmapStyle.style,
              bitmapStyle.smoothImage, null, x, y);
            break;
          case PathCommand.LineEnd:
            strokePath = null;
            break;
          default:
            release || assertUnreachable('Invalid command ' + command + ' encountered at index' +
              commandIndex + ' of ' + commandsCount);
        }
      }
      release || assert(styles.bytesAvailable === 0);
      release || assert(commandIndex === commandsCount);
      release || assert(coordinatesIndex === data.coordinatesPosition);
      if (formOpen && fillPath) {
        fillPath.lineTo(formOpenX, formOpenY);
        strokePath && strokePath.lineTo(formOpenX, formOpenY);
      }
      leaveTimeline("RenderableMorphShape.deserializPaths");

      return paths;
    }

    private _createMorphPath(type: PathType, ratio: number, style: any, smoothImage: boolean,
                             strokeProperties: StrokeProperties, x: number, y: number): Path2D
    {
      var path = new StyledPath(type, style, smoothImage, strokeProperties);
      this._morphPaths[ratio].push(path);
      path.path.moveTo(x, y);
      return path.path;
    }

    private _readMorphMatrix(data: DataBuffer, morphData: DataBuffer, ratio: number): Matrix {
      return new Matrix (
        morph(data.readFloat(), morphData.readFloat(), ratio),
        morph(data.readFloat(), morphData.readFloat(), ratio),
        morph(data.readFloat(), morphData.readFloat(), ratio),
        morph(data.readFloat(), morphData.readFloat(), ratio),
        morph(data.readFloat(), morphData.readFloat(), ratio),
        morph(data.readFloat(), morphData.readFloat(), ratio)
      );
    }

    private _readMorphGradient(styles: DataBuffer, morphStyles: DataBuffer, ratio: number,
                               context: CanvasRenderingContext2D): CanvasGradient {
      // Assert at least one color stop.
      release || assert(styles.bytesAvailable >= 1 + 1 + 6 * 4 /* matrix fields as floats */ +
        1 + 1 + 4 + 1 + 1);
      var gradientType = styles.readUnsignedByte();
      var focalPoint = styles.readShort() * 2 / 0xff;
      release || assert(focalPoint >= -1 && focalPoint <= 1);
      var transform = this._readMorphMatrix(styles, morphStyles, ratio);
      var gradient = gradientType === GradientType.Linear ?
        context.createLinearGradient(-1, 0, 1, 0) :
        context.createRadialGradient(focalPoint, 0, 0, 0, 0, 1);
      gradient.setTransform && gradient.setTransform(transform.toSVGMatrix());
      var colorStopsCount = styles.readUnsignedByte();
      for (var i = 0; i < colorStopsCount; i++) {
        var stop = morph(
            styles.readUnsignedByte() / 0xff, morphStyles.readUnsignedByte() / 0xff, ratio
        );
        var color = morphColor(
          styles.readUnsignedInt(), morphStyles.readUnsignedInt(), ratio
        );
        var cssColor = ColorUtilities.rgbaToCSSStyle(color);
        gradient.addColorStop(stop, cssColor);
      }

      // Skip spread and interpolation modes for now.
      styles.position += 2;

      return gradient;
    }

    private _readMorphBitmap(styles: DataBuffer, morphStyles: DataBuffer, ratio: number,
                             context: CanvasRenderingContext2D): {style: CanvasPattern;
      smoothImage: boolean}
    {
      release || assert(styles.bytesAvailable >= 4 + 6 * 4 /* matrix fields as floats */ + 1 + 1);
      var textureIndex = styles.readUnsignedInt();
      var fillTransform: Matrix = this._readMorphMatrix(styles, morphStyles, ratio);
      var repeat = styles.readBoolean() ? 'repeat' : 'no-repeat';
      var smooth = styles.readBoolean();
      var texture = this._textures[textureIndex];
      release || assert(texture._canvas);
      var fillStyle: CanvasPattern = context.createPattern(texture._canvas, repeat);
      fillStyle.setTransform(fillTransform.toSVGMatrix());
      return {style: fillStyle, smoothImage: smooth};
    }

  }

  export class TextLine {
    private static _measureContext = document.createElement('canvas').getContext('2d');

    x: number = 0;
    y: number = 0;
    width: number = 0;
    ascent: number = 0;
    descent: number = 0;
    leading: number = 0;
    align: number = 0;
    runs: TextRun[] = [];

    addRun(font: string, fillStyle: string, text: string, underline: boolean) {
      if (text) {
        TextLine._measureContext.font = font;
        var width = TextLine._measureContext.measureText(text).width | 0;
        this.runs.push(new TextRun(font, fillStyle, text, width, underline));
        this.width += width;
      }
    }

    wrap(maxWidth: number): TextLine[] {
      var lines: TextLine[] = [this];
      var runs = this.runs;

      var currentLine = this;
      currentLine.width = 0;
      currentLine.runs = [];

      var measureContext = TextLine._measureContext;

      for (var i = 0; i < runs.length; i++) {
        var run = runs[i];
        var text = run.text;
        run.text = '';
        run.width = 0;
        measureContext.font = run.font;
        var spaceLeft = maxWidth;
        var words = text.split(/[\s.-]/);
        var offset = 0;
        for (var j = 0; j < words.length; j++) {
          var word = words[j];
          var chunk = text.substr(offset, word.length + 1);
          var wordWidth = measureContext.measureText(chunk).width | 0;
          if (wordWidth > spaceLeft) {
            do {
              currentLine.runs.push(run);
              currentLine.width += run.width;
              run = new TextRun(run.font, run.fillStyle, '', 0, run.underline);
              var newLine = new TextLine();
              newLine.y = (currentLine.y + currentLine.descent + currentLine.leading + currentLine.ascent) | 0;
              newLine.ascent = currentLine.ascent;
              newLine.descent = currentLine.descent;
              newLine.leading = currentLine.leading;
              newLine.align = currentLine.align;
              lines.push(newLine);
              currentLine = newLine;
              spaceLeft = maxWidth - wordWidth;
              if (spaceLeft < 0) {
                var k = chunk.length;
                var t;
                var w;
                do {
                  k--;
                  t = chunk.substr(0, k);
                  w = measureContext.measureText(t).width | 0;
                } while (w > maxWidth);
                run.text = t;
                run.width = w;
                chunk = chunk.substr(k);
                wordWidth = measureContext.measureText(chunk).width | 0;
              }
            } while (spaceLeft < 0);
          } else {
            spaceLeft = spaceLeft - wordWidth;
          }
          run.text += chunk;
          run.width += wordWidth;
          offset += word.length + 1;
        }
        currentLine.runs.push(run);
        currentLine.width += run.width;
      }

      return lines;
    }
  }

  export class TextRun {
    constructor(public font: string = '',
                public fillStyle: string = '',
                public text: string = '',
                public width: number = 0,
                public underline: boolean = false)
    {

    }
  }

  export class RenderableText extends Renderable {

    _flags = RenderableFlags.Dynamic | RenderableFlags.Dirty;
    properties: {[name: string]: any} = {};

    private _textBounds: Rectangle;
    private _textRunData: DataBuffer;
    private _plainText: string;
    private _backgroundColor: number;
    private _borderColor: number;
    private _matrix: Shumway.GFX.Geometry.Matrix;
    private _coords: DataBuffer;
    private _scrollV: number;
    private _scrollH: number;

    textRect: Rectangle;
    lines: TextLine[];

    constructor(bounds) {
      super(bounds);
      this._textBounds = bounds.clone();
      this._textRunData = null;
      this._plainText = '';
      this._backgroundColor = 0;
      this._borderColor = 0;
      this._matrix = Matrix.createIdentity();
      this._coords = null;
      this._scrollV = 1;
      this._scrollH = 0;
      this.textRect = bounds.clone();
      this.lines = [];
    }

    setBounds(bounds): void {
      this._bounds.set(bounds);
      this._textBounds.set(bounds);
      this.textRect.setElements(bounds.x + 2, bounds.y + 2, bounds.x - 2, bounds.x - 2);
    }

    setContent(plainText: string, textRunData: DataBuffer, matrix: Shumway.GFX.Geometry.Matrix, coords: DataBuffer): void {
      this._textRunData = textRunData;
      this._plainText = plainText;
      this._matrix.set(matrix);
      this._coords = coords;
      this.lines = [];
    }

    setStyle(backgroundColor: number, borderColor: number, scrollV: number, scrollH: number): void {
      this._backgroundColor = backgroundColor;
      this._borderColor = borderColor;
      this._scrollV = scrollV;
      this._scrollH = scrollH;
    }

    reflow(autoSize: number, wordWrap: boolean): void {
      var textRunData = this._textRunData;

      if (!textRunData) {
        return;
      }

      var bounds = this._bounds;
      var availableWidth = bounds.w - 4;
      var plainText = this._plainText;
      var lines = this.lines;

      var currentLine = new TextLine();
      var baseLinePos = 0;
      var maxWidth = 0;
      var maxAscent = 0;
      var maxDescent = 0;
      var maxLeading = 0;
      var firstAlign = -1;

      var finishLine = function () {
        if (!currentLine.runs.length) {
          baseLinePos += maxAscent + maxDescent + maxLeading;
          return;
        }

        baseLinePos += maxAscent;
        currentLine.y = baseLinePos | 0;
        baseLinePos += maxDescent + maxLeading;
        currentLine.ascent = maxAscent;
        currentLine.descent = maxDescent;
        currentLine.leading = maxLeading;
        currentLine.align = firstAlign;

        if (wordWrap && currentLine.width > availableWidth) {
          var wrappedLines = currentLine.wrap(availableWidth);
          for (var i = 0; i < wrappedLines.length; i++) {
            var line = wrappedLines[i];
            baseLinePos = line.y + line.descent + line.leading;
            lines.push(line);
            if (line.width > maxWidth) {
              maxWidth = line.width;
            }
          }
        } else {
          lines.push(currentLine);
          if (currentLine.width > maxWidth) {
            maxWidth = currentLine.width;
          }
        }

        currentLine = new TextLine();
      };

      enterTimeline("RenderableText.reflow");

      while (textRunData.position < textRunData.length) {
        var beginIndex = textRunData.readInt();
        var endIndex = textRunData.readInt();

        var size = textRunData.readInt();
        var fontId = textRunData.readInt();
        var fontName:string;
        if (fontId) {
          fontName = 'swffont' + fontId;
        } else {
          fontName = textRunData.readUTF();
        }

        var ascent = textRunData.readInt();
        var descent = textRunData.readInt();
        var leading = textRunData.readInt();
        if (ascent > maxAscent) {
          maxAscent = ascent;
        }
        if (descent > maxDescent) {
          maxDescent = descent;
        }
        if (leading > maxLeading) {
          maxLeading = leading;
        }

        var bold = textRunData.readBoolean();
        var italic = textRunData.readBoolean();
        var boldItalic = '';
        if (italic) {
          boldItalic += 'italic';
        }
        if (bold) {
          boldItalic += ' bold';
        }
        var font = boldItalic + ' ' + size + 'px ' + fontName;

        var color = textRunData.readInt();
        var fillStyle = ColorUtilities.rgbToHex(color);

        var align = textRunData.readInt();
        if (firstAlign === -1) {
          firstAlign = align;
        }

        var bullet = textRunData.readBoolean();
        //var display = textRunData.readInt();
        var indent = textRunData.readInt();
        //var blockIndent = textRunData.readInt();
        var kerning = textRunData.readInt();
        var leftMargin = textRunData.readInt();
        var letterSpacing = textRunData.readInt();
        var rightMargin = textRunData.readInt();
        //var tabStops = textRunData.readInt();
        var underline = textRunData.readBoolean();

        var text = '';
        var eof = false;
        for (var i = beginIndex; !eof; i++) {
          var eof = i >= endIndex - 1;

          var char = plainText[i];
          if (char !== '\r' && char !== '\n') {
            text += char;
            if (i < plainText.length - 1) {
              continue;
            }
          }
          currentLine.addRun(font, fillStyle, text, underline);
          finishLine();
          text = '';

          if (eof) {
            maxAscent = 0;
            maxDescent = 0;
            maxLeading = 0;
            firstAlign = -1;
            break;
          }

          if (char === '\r' && plainText[i + 1] === '\n') {
            i++;
          }
        }
        currentLine.addRun(font, fillStyle, text, underline);
      }

      // Append an additional empty line if we find a line break character at the end of the text.
      var endCharacter = plainText[plainText.length - 1];
      if (endCharacter === '\r' || endCharacter === '\n') {
        lines.push(currentLine);
      }

      var rect = this.textRect;
      rect.w = maxWidth;
      rect.h = baseLinePos;

      if (autoSize) {
        if (!wordWrap) {
          availableWidth = maxWidth;
          var width = bounds.w;
          switch (autoSize) {
            case 1: // CENTER
              rect.x = (width - (availableWidth + 4)) >> 1;
              break;
            case 2: // LEFT
              break;
            case 3: // RIGHT
              rect.x = width - (availableWidth + 4);
              break;
          }
          this._textBounds.setElements(rect.x - 2, rect.y - 2, rect.w + 4, rect.h + 4);
        }
        bounds.h = baseLinePos + 4;
      } else {
        this._textBounds = bounds;
      }

      var numLines = lines.length;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.width < availableWidth) {
          switch (line.align) {
            case 0: // left
              break;
            case 1: // right
              line.x = (availableWidth - line.width) | 0;
              break;
            case 2: // center
              line.x = ((availableWidth - line.width) / 2) | 0;
              break;
          }
        }
      }

      this.invalidatePaint()
      leaveTimeline("RenderableText.reflow");
    }

    getBounds(): Shumway.GFX.Geometry.Rectangle {
      return this._bounds;
    }

    render(context: CanvasRenderingContext2D): void {
      enterTimeline("RenderableText.render");
      context.save();

      var rect = this._textBounds;
      if (this._backgroundColor) {
        context.fillStyle = ColorUtilities.rgbaToCSSStyle(this._backgroundColor);
        context.fillRect(rect.x, rect.y, rect.w, rect.h);
      }
      if (this._borderColor) {
        context.strokeStyle = ColorUtilities.rgbaToCSSStyle(this._borderColor);
        context.lineCap = 'square';
        context.lineWidth = 1;
        context.strokeRect(rect.x, rect.y, rect.w, rect.h);
      }

      if (this._coords) {
        this._renderChars(context);
      } else {
        this._renderLines(context);
      }

      context.restore();
      leaveTimeline("RenderableText.render");
    }

    private _renderChars(context: CanvasRenderingContext2D) {
      if (this._matrix) {
        var m = this._matrix;
        context.transform(m.a, m.b, m.c, m.d, m.tx, m.ty);
      }
      var lines = this.lines;
      var coords = this._coords;
      coords.position = 0;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var runs = line.runs;
        for (var j = 0; j < runs.length; j++) {
          var run = runs[j];
          context.font = run.font;
          context.fillStyle = run.fillStyle;
          var text = run.text;
          for (var k = 0; k < text.length; k++) {
            var x = coords.readInt() / 20;
            var y = coords.readInt() / 20;
            context.fillText(text[k], x, y);
          }
        }
      }
    }

    private _renderLines(context: CanvasRenderingContext2D) {
      // TODO: Render bullet points.
      var bounds = this._textBounds;
      context.beginPath();
      context.rect(bounds.x + 2, bounds.y + 2, bounds.w - 4, bounds.h - 4);
      context.clip();
      context.translate((bounds.x - this._scrollH) + 2, bounds.y + 2);
      var lines = this.lines;
      var scrollV = this._scrollV;
      var scrollY = 0;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var x = line.x;
        var y = line.y;
        // Skip lines until we are within the scroll view.
        if (i + 1 < scrollV) {
          scrollY = y + line.descent + line.leading;
          continue;
        }
        y -= scrollY;
        // Flash skips rendering lines that are not fully visible in height (except of the very
        // first line within the scroll view).
        if ((i + 1) - scrollV && y > bounds.h) {
          break;
        }
        var runs = line.runs;
        for (var j = 0; j < runs.length; j++) {
          var run = runs[j];
          context.font = run.font;
          context.fillStyle = run.fillStyle;
          if (run.underline) {
            context.fillRect(x, (y + (line.descent / 2)) | 0, run.width, 1);
          }
          context.fillText(run.text, x, y);
          x += run.width;
        }
      }
    }
  }

  export class Label extends Renderable {
    _flags: RenderableFlags = RenderableFlags.Dynamic | RenderableFlags.Scalable;
    properties: {[name: string]: any} = {};
    private _text: string;

    get text (): string {
      return this._text;
    }

    set text (value: string) {
      this._text = value;
    }

    constructor(w: number, h: number) {
      super(new Rectangle(0, 0, w, h));
    }

    render (context: CanvasRenderingContext2D, ratio: number, cullBounds?: Rectangle) {
      context.save();
      context.textBaseline = "top";
      context.fillStyle = "white";
      context.fillText(this.text, 0, 0);
      context.restore();
    }
  }
}
