/*
 * Copyright 2014 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
///<reference path='../references.ts' />

module Shumway.AVM2.AS {
  import assertNotImplemented = Shumway.Debug.assertNotImplemented;
  import notImplemented = Shumway.Debug.notImplemented;
  import unexpected = Shumway.Debug.unexpected;
  import asCoerceString = Shumway.AVM2.Runtime.asCoerceString;
  import createEmptyObject = Shumway.ObjectUtilities.createEmptyObject;
  import Namespace = Shumway.AVM2.ABC.Namespace;
  import Multiname = Shumway.AVM2.ABC.Multiname;
  import throwError = Shumway.AVM2.Runtime.throwError;

  import utf8decode = Shumway.StringUtilities.utf8decode;
  import utf8encode = Shumway.StringUtilities.utf8encode;
  import clamp = Shumway.NumberUtilities.clamp;
  import swap16 = Shumway.IntegerUtilities.swap16;
  import swap32 = Shumway.IntegerUtilities.swap32;
  import floatToInt32 = Shumway.IntegerUtilities.floatToInt32;
  import int32ToFloat = Shumway.IntegerUtilities.int32ToFloat;

  import DataBuffer = Shumway.ArrayUtilities.DataBuffer;

  function throwEOFError() {
    notImplemented("throwEOFError");
    // Runtime.throwErrorFromVM(AVM2.currentDomain(), "flash.errors.EOFError", "End of file was encountered.");
  }

  function throwRangeError() {
    notImplemented("throwEOFError");
    // var error = Errors.ParamRangeError;
    // Runtime.throwErrorFromVM("RangeError", getErrorMessage(error.code), error.code);
  }

  function throwCompressedDataError() {
    notImplemented("throwEOFError");
//    var error = Errors.CompressedDataError;
//    Runtime.throwErrorFromVM("CompressedDataError", getErrorMessage(error.code), error.code);
  }

  function checkRange(x: number, min: number, max: number) {
    if (x !== clamp(x, min, max)) {
      throwRangeError();
    }
  }


  declare var AMFUtils;

  export module flash.net {
    export class ObjectEncoding extends ASNative {
      public static AMF0 = 0;
      public static AMF3 = 3;
      public static DEFAULT = ObjectEncoding.AMF3;
    }
  }

  export module flash.utils {
    var _asGetProperty = Object.prototype.asGetProperty;
    var _asSetProperty = Object.prototype.asSetProperty;
    var _asCallProperty = Object.prototype.asCallProperty;
    var _asHasProperty = Object.prototype.asHasProperty;
    var _asHasOwnProperty = Object.prototype.asHasOwnProperty;
    var _asHasTraitProperty = Object.prototype.asHasTraitProperty;
    var _asDeleteProperty = Object.prototype.asDeleteProperty;

    export interface IDataInput {
      readBytes: (bytes: flash.utils.ByteArray, offset?: number /*uint*/, length?: number /*uint*/) => void;
      readBoolean: () => boolean;
      readByte: () => number /*int*/;
      readUnsignedByte: () => number /*uint*/;
      readShort: () => number /*int*/;
      readUnsignedShort: () => number /*uint*/;
      readInt: () => number /*int*/;
      readUnsignedInt: () => number /*uint*/;
      readFloat: () => number;
      readDouble: () => number;
      readMultiByte: (length: number /*uint*/, charSet: string) => string;
      readUTF: () => string;
      readUTFBytes: (length: number /*uint*/) => string;
      bytesAvailable: number /*uint*/;
      readObject: () => any;
      objectEncoding: number /*uint*/;
      endian: string;
    }

    export interface IDataOutput {
      writeBytes: (bytes: flash.utils.ByteArray, offset?: number /*uint*/, length?: number /*uint*/) => void;
      writeBoolean: (value: boolean) => void;
      writeByte: (value: number /*int*/) => void;
      writeShort: (value: number /*int*/) => void;
      writeInt: (value: number /*int*/) => void;
      writeUnsignedInt: (value: number /*uint*/) => void;
      writeFloat: (value: number) => void;
      writeDouble: (value: number) => void;
      writeMultiByte: (value: string, charSet: string) => void;
      writeUTF: (value: string) => void;
      writeUTFBytes: (value: string) => void;
      writeObject: (object: any) => void;
      objectEncoding: number /*uint*/;
      endian: string;
    }

    export class ByteArray extends ASNative implements IDataInput, IDataOutput {

      public static instanceConstructor: any = DataBuffer;
      public static staticNatives: any [] = [DataBuffer];
      public static instanceNatives: any [] = [DataBuffer.prototype];
      public static callableConstructor: any = null;

      static initializer = function (source: any) {
        var self: ByteArray = this;
        var align = false;
        var buffer, length;
        if (source) {
          length = 'byteLength' in source ? source.byteLength : source.length;
          align = (length & 0x7) !== 0;
          if (source instanceof ArrayBuffer) {
            buffer = source;
          } else if ('buffer' in source && source.buffer instanceof ArrayBuffer) {
            buffer = align ? source.buffer : source.buffer.slice();
          } else if (Array.isArray) {
            buffer = align ? source : (new Uint8Array(source)).buffer;
          }
          // We have to make sure that the length of the buffer is a multiple of 8 or else
          // constructing 64 bit views will fail.
          if (align) {
            length = (length + 7) & ~0x7;
            var tmp = new ArrayBuffer(length);
            // Copy into new buffer.
            (new Uint8Array(tmp)).set(new Uint8Array(buffer));
            buffer = tmp;
          }
        } else {
          buffer = new ArrayBuffer(ByteArray.INITIAL_SIZE);
          length = 0;
        }
        self._buffer = buffer;
        self._length = length;
        self._position = 0;
        self._cacheViews();
        self._objectEncoding = ByteArray.defaultObjectEncoding;
        self._littleEndian = false; // AS3 is bigEndian by default.
        self._bitBuffer = 0;
        self._bitLength = 0;
      }

      static protocol: IProtocol = ByteArray.prototype;

      /* The initial size of the backing, in bytes. Doubled every OOM. */
      private static INITIAL_SIZE = 128;

      private static _defaultObjectEncoding: number = flash.net.ObjectEncoding.DEFAULT;

      static get defaultObjectEncoding(): number /*uint*/ {
        return this._defaultObjectEncoding;
      }

      static set defaultObjectEncoding(version: number /*uint*/) {
        version = version >>> 0;
        this._defaultObjectEncoding = version;
      }

      constructor() {
        false && super();
      }

      private _buffer: ArrayBuffer;
      private _length: number;
      private _position: number;
      private _littleEndian: boolean;
      private _objectEncoding: number;

      private _bitBuffer: number;
      private _bitLength: number;

      private _cacheViews: () => void;

      asGetNumericProperty: (name: number) => number;
      asSetNumericProperty: (name: number, value: number) => void;

//      readBytes: (bytes: flash.utils.ByteArray, offset: number, length: number) => void = DataBuffer.prototype.readByte;
//      writeBytes: (bytes: flash.utils.ByteArray, offset: number, length: number) => void = DataBuffer.prototype.writeBytes;

      readBytes: (bytes: flash.utils.ByteArray, offset?: number /*uint*/, length?: number /*uint*/) => void;
      readBoolean: () => boolean;
      readByte: () => number /*int*/;
      readUnsignedByte: () => number /*uint*/;
      readShort: () => number /*int*/;
      readUnsignedShort: () => number /*uint*/;
      readInt: () => number /*int*/;
      readUnsignedInt: () => number /*uint*/;
      readFloat: () => number;
      readDouble: () => number;
      readMultiByte: (length: number /*uint*/, charSet: string) => string;
      readUTF: () => string;
      readUTFBytes: (length: number /*uint*/) => string;
      bytesAvailable: number /*uint*/;
      readObject(): any {
        switch (this._objectEncoding) {
          case flash.net.ObjectEncoding.AMF0:
            return AMF0.read(this);
          case flash.net.ObjectEncoding.AMF3:
            return AMF3.read(this);
          default:
            unexpected("Object Encoding");
        }
      }

      writeBytes: (bytes: flash.utils.ByteArray, offset?: number /*uint*/, length?: number /*uint*/) => void;
      writeBoolean: (value: boolean) => void;
      writeByte: (value: number /*int*/) => void;
      writeShort: (value: number /*int*/) => void;
      writeInt: (value: number /*int*/) => void;
      writeUnsignedInt: (value: number /*uint*/) => void;
      writeFloat: (value: number) => void;
      writeDouble: (value: number) => void;
      writeMultiByte: (value: string, charSet: string) => void;
      writeUTF: (value: string) => void;
      writeUTFBytes: (value: string) => void;
      writeObject(object: any) {
        switch (this._objectEncoding) {
          case flash.net.ObjectEncoding.AMF0:
            return AMF0.write(this, object);
          case flash.net.ObjectEncoding.AMF3:
            return AMF3.write(this, object);
          default:
            unexpected("Object Encoding");
        }
      }

      objectEncoding: number /*uint*/;
      endian: string;

      readRawBytes: () => Int8Array;
      writeRawBytes: (bytes: Uint8Array) => void;
      position: number;
      length: number;

//      Maybe Someday
//      atomicCompareAndSwapIntAt(byteIndex: number /*int*/, expectedValue: number /*int*/, newValue: number /*int*/): number /*int*/ {
//        byteIndex = byteIndex | 0; expectedValue = expectedValue | 0; newValue = newValue | 0;
//        notImplemented("public flash.utils.ByteArray::atomicCompareAndSwapIntAt"); return;
//      }
//      atomicCompareAndSwapLength(expectedLength: number /*int*/, newLength: number /*int*/): number /*int*/ {
//        expectedLength = expectedLength | 0; newLength = newLength | 0;
//        notImplemented("public flash.utils.ByteArray::atomicCompareAndSwapLength"); return;
//      }
//      get shareable(): boolean {
//        notImplemented("public flash.utils.ByteArray::get shareable"); return;
//      }
//      set shareable(newValue: boolean) {
//        newValue = !!newValue;
//        notImplemented("public flash.utils.ByteArray::set shareable"); return;
//      }

    }

    ByteArray.prototype.asGetNumericProperty = DataBuffer.prototype.getValue;
    ByteArray.prototype.asSetNumericProperty = DataBuffer.prototype.setValue;

    export var OriginalByteArray = ByteArray;
  }
}
