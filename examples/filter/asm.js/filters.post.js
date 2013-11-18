
  var preMultiplyAlpha = Module.cwrap('preMultiplyAlpha', null, ['number', 'number', 'number']);
  var unpreMultiplyAlpha = Module.cwrap('unpreMultiplyAlpha', null, ['number', 'number', 'number']);
  var dropshadow = Module.cwrap('dropshadow', null, ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number']);
  var blur = Module.cwrap('blur', null, ['number', 'number', 'number', 'number', 'number', 'number']);

  return {
    preMultiplyAlpha: preMultiplyAlpha,
    unpreMultiplyAlpha: unpreMultiplyAlpha,
    dropshadow: dropshadow,
    blur: blur,
  };

})();
