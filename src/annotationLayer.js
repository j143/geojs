var inherit = require('./inherit');
var featureLayer = require('./featureLayer');
var geo_annotation = require('./annotation');
var geo_event = require('./event');
var registry = require('./registry');
var transform = require('./transform');
var $ = require('jquery');
var Mousetrap = require('mousetrap');
var textFeature = require('./textFeature');

/**
 * @typedef {object} geo.annotationLayer.labelRecord
 * @property {string} text The text of the label
 * @property {geo.geoPosition} position The position of the label in map gcs
 *      coordinates.
 * @property {object} [style] A `geo.textFeature` style object.
 */

/**
 * Layer to handle direct interactions with different features.  Annotations
 * (features) can be created by calling mode(<name of feature>) or cancelled
 * with mode(null).
 *
 * @class
 * @alias geo.annotationLayer
 * @extends geo.featureLayer
 * @param {object} [args] Layer options.
 * @param {number} [args.dblClickTime=300] The delay in milliseconds that is
 *    treated as a double-click when working with annotations.
 * @param {number} [args.adjacentPointProximity=5] The minimum distance in
 *    display coordinates (pixels) between two adjacent points when creating a
 *    polygon or line.  A value of 0 requires an exact match.
 * @param {number} [args.continousPointProximity=5] The minimum distance in
 *    display coordinates (pixels) between two adjacent points when dragging
 *    to create an annotation.  `false` disables continuous drawing mode.
 * @param {number} [args.finalPointProximity=10] The maximum distance in
 *    display coordinates (pixels) between the starting point and the mouse
 *    coordinates to signal closing a polygon.  A value of 0 requires an exact
 *    match.  A negative value disables closing a polygon by clicking on the
 *    start point.
 * @param {boolean} [args.showLabels=true] Truthy to show feature labels that
 *    are allowed by the associated feature to be shown.
 * @param {object} [args.defaultLabelStyle] Default styles for labels.
 * @returns {geo.annotationLayer}
 */
var annotationLayer = function (args) {
  'use strict';
  if (!(this instanceof annotationLayer)) {
    return new annotationLayer(args);
  }
  featureLayer.call(this, args);

  var mapInteractor = require('./mapInteractor');
  var timestamp = require('./timestamp');
  var util = require('./util');

  var m_this = this,
      s_init = this._init,
      s_exit = this._exit,
      s_draw = this.draw,
      s_update = this._update,
      m_buildTime = timestamp(),
      m_options,
      m_mode = null,
      m_annotations = [],
      m_features = [],
      m_labelFeature,
      m_labelLayer;

  var geojsonStyleProperties = {
    'closed': {dataType: 'boolean', keys: ['closed', 'close']},
    'fill': {dataType: 'boolean', keys: ['fill']},
    'fillColor': {dataType: 'color', keys: ['fillColor', 'fill-color', 'marker-color', 'fill']},
    'fillOpacity': {dataType: 'opacity', keys: ['fillOpacity', 'fill-opacity']},
    'lineCap': {dataType: 'text', keys: ['lineCap', 'line-cap']},
    'lineJoin': {dataType: 'text', keys: ['lineJoin', 'line-join']},
    'radius': {dataType: 'positive', keys: ['radius']},
    'scaled': {dataType: 'booleanOrNumber', keys: ['scaled']},
    'stroke': {dataType: 'boolean', keys: ['stroke']},
    'strokeColor': {dataType: 'color', keys: ['strokeColor', 'stroke-color', 'stroke']},
    'strokeOffset': {dataType: 'number', keys: ['strokeOffset', 'stroke-offset']},
    'strokeOpacity': {dataType: 'opacity', keys: ['strokeOpacity', 'stroke-opacity']},
    'strokeWidth': {dataType: 'positive', keys: ['strokeWidth', 'stroke-width']}
  };
  textFeature.usedStyles.forEach(function (key) {
    geojsonStyleProperties[key] = {
      option: 'labelStyle',
      dataType: ['visible', 'rotateWithMap', 'scaleWithMap'].indexOf(key) >= 0 ? 'boolean' : (
        ['scale'].indexOf(key) >= 0 ? 'booleanOrNumber' : (
        ['rotation'].indexOf(key) >= 0 ? 'angle' : (
        ['offset', 'shadowOffset'].indexOf(key) >= 0 ? 'coordinate2' : (
        ['shadowBlur, strokeWidth'].indexOf(key) >= 0 ? 'numberOrBlank' :
        'text')))),
      keys: [
        key,
        'label' + key.charAt(0).toUpperCase() + key.slice(1),
        key.replace(/([A-Z])/g, '-$1').toLowerCase(),
        'label-' + key.replace(/([A-Z])/g, '-$1').toLowerCase()]
    };
  });

  m_options = $.extend(true, {}, {
    dblClickTime: 300,
    adjacentPointProximity: 5,  // in pixels, 0 is exact
    // in pixels; set to continuousPointProximity to false to disable
    // continuous drawing modes.
    continuousPointProximity: 5,
    finalPointProximity: 10,  // in pixels, 0 is exact
    showLabels: true
  }, args);

  /**
   * Process an action event.  If we are in rectangle-creation mode, this
   * creates a rectangle.
   *
   * @param {geo.event} evt The selection event.
   */
  this._processAction = function (evt) {
    var update;
    if (evt.state && evt.state.actionRecord &&
        evt.state.actionRecord.owner === geo_annotation.actionOwner &&
        this.currentAnnotation) {
      update = this.currentAnnotation.processAction(evt);
    }
    this._updateFromEvent(update);
  };

  /**
   * Handle updating the current annotation based on an update state.
   *
   * @param {string|undefined} update Truthy to update.  `'done'` if the
   *    annotation was completed and the mode should return to `null`.
   *    `'remove'` to remove the current annotation and set the mode to `null`.
   *    Falsy to do nothing.
   */
  this._updateFromEvent = function (update) {
    switch (update) {
      case 'remove':
        m_this.removeAnnotation(m_this.currentAnnotation, false);
        m_this.mode(null);
        break;
      case 'done':
        m_this.mode(null);
        break;
    }
    if (update) {
      m_this.modified();
      m_this.draw();
    }
  };

  /**
   * Handle mouse movement.  If there is a current annotation, the movement
   * event is sent to it.
   *
   * @param {geo.event} evt The mouse move event.
   */
  this._handleMouseMove = function (evt) {
    if (this.mode() && this.currentAnnotation) {
      var update = this.currentAnnotation.mouseMove(evt);
      if (update) {
        m_this.modified();
        m_this.draw();
      }
    }
  };

  /**
   * Handle mouse clicks.  If there is a current annotation, the click event is
   * sent to it.
   *
   * @param {geo.event} evt The mouse click event.
   */
  this._handleMouseClick = function (evt) {
    if (this.mode() && this.currentAnnotation) {
      var update = this.currentAnnotation.mouseClick(evt);
      this._updateFromEvent(update);
    }
  };

  /**
   * Set or get options.
   *
   * @param {string|object} [arg1] If `undefined`, return the options object.
   *    If a string, either set or return the option of that name.  If an
   *    object, update the options with the object's values.
   * @param {object} [arg2] If `arg1` is a string and this is defined, set
   *    the option to this value.
   * @returns {object|this} If options are set, return the annotation,
   *    otherwise return the requested option or the set of options.
   */
  this.options = function (arg1, arg2) {
    if (arg1 === undefined) {
      return m_options;
    }
    if (typeof arg1 === 'string' && arg2 === undefined) {
      return m_options[arg1];
    }
    if (arg2 === undefined) {
      m_options = $.extend(true, m_options, arg1);
    } else {
      m_options[arg1] = arg2;
    }
    this.modified();
    return this;
  };

  /**
   * Calculate the display distance for two coordinate in the current map.
   *
   * @param {geo.geoPosition|geo.screenPosition} coord1 The first coordinates.
   * @param {string|geo.transform|null} gcs1 `undefined` to use the interface
   *    gcs, `null` to use the map gcs, `'display`' if the coordinates are
   *    already in display coordinates, or any other transform.
   * @param {geo.geoPosition|geo.screenPosition} coord2 the second coordinates.
   * @param {string|geo.transform|null} [gcs2] `undefined` to use the interface
   *    gcs, `null` to use the map gcs, `'display`' if the coordinates are
   *    already in display coordinates, or any other transform.
   * @returns {number} the Euclidian distance between the two coordinates.
   */
  this.displayDistance = function (coord1, gcs1, coord2, gcs2) {
    var map = this.map();
    if (gcs1 !== 'display') {
      gcs1 = (gcs1 === null ? map.gcs() : (
              gcs1 === undefined ? map.ingcs() : gcs1));
      coord1 = map.gcsToDisplay(coord1, gcs1);
    }
    if (gcs2 !== 'display') {
      gcs2 = (gcs2 === null ? map.gcs() : (
              gcs2 === undefined ? map.ingcs() : gcs2));
      coord2 = map.gcsToDisplay(coord2, gcs2);
    }
    var dist = Math.sqrt(Math.pow(coord1.x - coord2.x, 2) +
                         Math.pow(coord1.y - coord2.y, 2));
    return dist;
  };

  /**
   * Add an annotation to the layer.  The annotation could be in any state.
   *
   * @param {geo.annotation} annotation Te annotation to add.
   * @param {string|geo.transform|null} [gcs] `undefined` to use the interface
   *    gcs, `null` to use the map gcs, or any other transform.
   * @returns {this} The current layer.
   */
  this.addAnnotation = function (annotation, gcs) {
    var pos = $.inArray(annotation, m_annotations);
    if (pos < 0) {
      m_this.geoTrigger(geo_event.annotation.add_before, {
        annotation: annotation
      });
      m_annotations.push(annotation);
      annotation.layer(this);
      var map = this.map();
      gcs = (gcs === null ? map.gcs() : (
             gcs === undefined ? map.ingcs() : gcs));
      if (gcs !== map.gcs()) {
        annotation._coordinates(transform.transformCoordinates(
            gcs, map.gcs(), annotation._coordinates()));
      }
      this.modified();
      this.draw();
      m_this.geoTrigger(geo_event.annotation.add, {
        annotation: annotation
      });
    }
    return this;
  };

  /**
   * Remove an annotation from the layer.
   *
   * @param {geo.annoation} annotation The annotation to remove.
   * @param {boolean} update If `false`, don't update the layer after removing
   *    the annotation.
   * @returns {boolean} `true` if an annotation was removed.
   */
  this.removeAnnotation = function (annotation, update) {
    var pos = $.inArray(annotation, m_annotations);
    if (pos >= 0) {
      if (annotation === this.currentAnnotation) {
        this.currentAnnotation = null;
      }
      annotation._exit();
      m_annotations.splice(pos, 1);
      if (update !== false) {
        this.modified();
        this.draw();
      }
      m_this.geoTrigger(geo_event.annotation.remove, {
        annotation: annotation
      });
    }
    return pos >= 0;
  };

  /**
   * Remove all annotations from the layer.
   *
   * @param {boolean} [skipCreating] If truthy, don't remove annotations that
   *    are in the create state.
   * @param {boolean} [update] If `false`, don't update the layer after
   *    removing the annotation.
   * @returns {number} The number of annotations that were removed.
   */
  this.removeAllAnnotations = function (skipCreating, update) {
    var removed = 0, annotation, pos = 0;
    while (pos < m_annotations.length) {
      annotation = m_annotations[pos];
      if (skipCreating && annotation.state() === geo_annotation.state.create) {
        pos += 1;
        continue;
      }
      this.removeAnnotation(annotation, false);
      removed += 1;
    }
    if (removed && update !== false) {
      this.modified();
      this.draw();
    }
    return removed;
  };

  /**
   * Get the list of annotations on the layer.
   *
   * @returns {geo.annoation[]} An array of annotations.
   */
  this.annotations = function () {
    return m_annotations.slice();
  };

  /**
   * Get an annotation by its id.
   *
   * @param {number} id The annotation ID.
   * @returns {geo.annotation} The selected annotation or `undefined` if none
   *    matches the id.
   */
  this.annotationById = function (id) {
    if (id !== undefined && id !== null) {
      id = +id;  /* Cast to int */
    }
    var annotations = m_annotations.filter(function (annotation) {
      return annotation.id() === id;
    });
    if (annotations.length) {
      return annotations[0];
    }
  };

  /**
   * Get or set the current mode.  The mode is either `null` for nothing being
   * created, or the name of the type of annotation that is being created.
   *
   * @param {string|null} [arg] The new mode or `undefined` to get the current
   *    mode.
   * @returns {string|null|this} The current mode or the layer.
   */
  this.mode = function (arg) {
    if (arg === undefined) {
      return m_mode;
    }
    if (arg !== m_mode) {
      var createAnnotation, actions,
          mapNode = m_this.map().node(), oldMode = m_mode;
      m_mode = arg;
      mapNode.toggleClass('annotation-input', !!m_mode);
      if (m_mode) {
        Mousetrap(mapNode[0]).bind('esc', function () { m_this.mode(null); });
      } else {
        Mousetrap(mapNode[0]).unbind('esc');
      }
      if (this.currentAnnotation) {
        switch (this.currentAnnotation.state()) {
          case geo_annotation.state.create:
            this.removeAnnotation(this.currentAnnotation);
            break;
        }
        this.currentAnnotation = null;
      }
      switch (m_mode) {
        case 'line':
          createAnnotation = geo_annotation.lineAnnotation;
          break;
        case 'point':
          createAnnotation = geo_annotation.pointAnnotation;
          break;
        case 'polygon':
          createAnnotation = geo_annotation.polygonAnnotation;
          break;
        case 'rectangle':
          createAnnotation = geo_annotation.rectangleAnnotation;
          break;
      }
      m_this.map().interactor().removeAction(
        undefined, undefined, geo_annotation.actionOwner);
      if (createAnnotation) {
        this.currentAnnotation = createAnnotation({
          state: geo_annotation.state.create,
          layer: this
        });
        this.addAnnotation(m_this.currentAnnotation, null);
        actions = this.currentAnnotation.actions(geo_annotation.state.create);
        $.each(actions, function (idx, action) {
          m_this.map().interactor().addAction(action);
        });
      }
      m_this.geoTrigger(geo_event.annotation.mode, {
        mode: m_mode, oldMode: oldMode});
    }
    return this;
  };

  /**
   * Return the current set of annotations as a geojson object.  Alternately,
   * add a set of annotations from a geojson object.
   *
   * @param {string|objectFile} [geojson] If present, add annotations based on
   *    the given geojson object.  If `undefined`, return the current
   *    annotations as geojson.  This may be a JSON string, a javascript
   *    object, or a File object.
   * @param {boolean} [clear] If `true`, when adding annotations, first remove
   *    all existing objects.  If `'update'`, update existing annotations and
   *    remove annotations that no longer exit,  If falsy, update existing
   *    annotations and leave unchanged annotations.
   * @param {string|geo.transform|null} [gcs] `undefined` to use the interface
   *    gcs, `null` to use the map gcs, or any other transform.
   * @param {boolean} [includeCrs] If truthy, include the coordinate system in
   *    the output.
   * @returns {object|number|undefined} If `geojson` was undefined, the current
   *    annotations as a javascript object that can be converted to geojson
   *    using JSON.stringify.  If `geojson` is specified, either the number of
   *    annotations now present upon success, or `undefined` if the value in
   *    `geojson` was not able to be parsed.
   */
  this.geojson = function (geojson, clear, gcs, includeCrs) {
    if (geojson !== undefined) {
      var reader = registry.createFileReader('jsonReader', {layer: this});
      if (!reader.canRead(geojson)) {
        return;
      }
      if (clear === true) {
        this.removeAllAnnotations(true, false);
      }
      if (clear === 'update') {
        $.each(this.annotations(), function (idx, annotation) {
          annotation.options('updated', false);
        });
      }
      reader.read(geojson, function (features) {
        $.each(features.slice(), function (feature_idx, feature) {
          m_this._geojsonFeatureToAnnotation(feature, gcs);
          m_this.deleteFeature(feature);
        });
      });
      if (clear === 'update') {
        $.each(this.annotations(), function (idx, annotation) {
          if (annotation.options('updated') === false &&
              annotation.state() === geo_annotation.state.done) {
            m_this.removeAnnotation(annotation, false);
          }
        });
      }
      this.modified();
      this.draw();
      return m_annotations.length;
    }
    geojson = null;
    var features = [];
    $.each(m_annotations, function (annotation_idx, annotation) {
      var obj = annotation.geojson(gcs, includeCrs);
      if (obj) {
        features.push(obj);
      }
    });
    if (features.length) {
      geojson = {
        type: 'FeatureCollection',
        features: features
      };
    }
    return geojson;
  };

  /**
   * Convert a feature as parsed by the geojson reader into one or more
   * annotations.
   *
   * @param {geo.feature} feature The feature to convert.
   * @param {string|geo.transform|null} [gcs] `undefined` to use the interface
   *    gcs, `null` to use the map gcs, or any other transform.
   */
  this._geojsonFeatureToAnnotation = function (feature, gcs) {
    var dataList = feature.data(),
        annotationList = registry.listAnnotations();
    $.each(dataList, function (data_idx, data) {
      var type = (data.properties || {}).annotationType || feature.featureType,
          options = $.extend({}, data.properties || {}),
          position, datagcs, i, existing;
      if ($.inArray(type, annotationList) < 0) {
        return;
      }
      options.style = options.style || {};
      options.labelStyle = options.labelStyle || {};
      delete options.annotationType;
      // the geoJSON reader can only emit line, polygon, and point
      switch (feature.featureType) {
        case 'line':
          position = feature.line()(data, data_idx);
          if (!position || position.length < 2) {
            return;
          }
          break;
        case 'polygon':
          position = feature.polygon()(data, data_idx);
          if (!position || !position.outer || position.outer.length < 3) {
            return;
          }
          position = position.outer;
          if (position[position.length - 1][0] === position[0][0] &&
              position[position.length - 1][1] === position[0][1]) {
            position.splice(position.length - 1, 1);
            if (position.length < 3) {
              return;
            }
          }
          break;
        case 'point':
          position = [feature.position()(data, data_idx)];
          break;
      }
      for (i = 0; i < position.length; i += 1) {
        position[i] = util.normalizeCoordinates(position[i]);
      }
      datagcs = ((data.crs && data.crs.type === 'name' && data.crs.properties &&
                  data.crs.properties.type === 'proj4' &&
                  data.crs.properties.name) ? data.crs.properties.name : gcs);
      if (datagcs !== m_this.map().gcs()) {
        position = transform.transformCoordinates(datagcs, m_this.map().gcs(), position);
      }
      options.coordinates = position;
      /* For each style listed in the geojsonStyleProperties object, check if
       * is given under any of the variety of keys as a valid instance of the
       * required data type.  If not, use the property from the feature. */
      $.each(geojsonStyleProperties, function (key, prop) {
        var value;
        $.each(prop.keys, function (idx, altkey) {
          if (value === undefined) {
            value = m_this.validateAttribute(options[altkey], prop.dataType);
          }
        });
        if (value === undefined) {
          value = m_this.validateAttribute(
            feature.style.get(key)(data, data_idx), prop.dataType);
        }
        if (value !== undefined) {
          options[prop.option || 'style'][key] = value;
        }
      });
      /* Delete property keys we have used */
      $.each(geojsonStyleProperties, function (key, prop) {
        $.each(prop.keys, function (idx, altkey) {
          delete options[altkey];
        });
      });
      if (options.annotationId !== undefined) {
        existing = m_this.annotationById(options.annotationId);
        delete options.annotationId;
      }
      if (existing && existing.type() === type && existing.state() === geo_annotation.state.done && existing.options('updated') === false) {
        /* We could change the state of the existing annotation if it differs
         * from done. */
        delete options.state;
        delete options.layer;
        options.updated = true;
        existing.options(options);
        m_this.geoTrigger(geo_event.annotation.update, {
          annotation: existing
        });
      } else {
        options.state = geo_annotation.state.done;
        options.layer = m_this;
        options.updated = 'new';
        m_this.addAnnotation(registry.createAnnotation(type, options), null);
      }
    });
  };

  /**
   * Validate a value for an attribute based on a specified data type.  This
   * returns a sanitized value or `undefined` if the value was invalid.  Data
   * types include:
   * - `color`: a css string, `#rrggbb` hex string, `#rgb` hex string, number,
   *   or object with r, g, b properties in the range of [0-1].
   * - `opacity`: a floating point number in the range [0, 1].
   * - `positive`: a floating point number greater than zero.
   * - `boolean`: a string whose lowercase value is `'false'`, `'off'`, or
   *   `'no'`, and falsy values are false, all else is true.  `null` and
   *   `undefined` are still considered invalid values.
   * - `booleanOrNumber`: a string whose lowercase value is `'false'`, `'off'`,
   *   `'no'`, `'true'`, `'on'`, or `'yes'`, falsy values that aren't 0, and
   *   `true` are handled as booleans.  Otherwise, a floating point number that
   *   isn't NaN or an infinity.
   * - `coordinate2`: either an object with x and y properties that are
   *   numbers, or a string of the form <x>[,]<y> with optional whitespace, or
   *   a JSON encoded object with x and y values, or a JSON encoded list of at
   *   leasst two numbers.
   * - `number`: a floating point number that isn't NaN or an infinity.
   * - `angle`: a number that represents radians.  If followed by one of `deg`,
   *   `grad`, or `turn`, it is converted to radians.  An empty string is also
   *   allowed.
   * - `text`: any text string.
   * @param {number|string|object|boolean} value The value to validate.
   * @param {string} dataType The data type for validation.
   * @returns {number|string|object|boolean|undefined} The sanitized value or
   *    `undefined`.
   */
  this.validateAttribute = function (value, dataType) {
    var parts;

    if (value === undefined || value === null) {
      return;
    }
    switch (dataType) {
      case 'angle':
        if (value === '') {
          break;
        }
        parts = /^\s*([-.0-9eE]+)\s*(deg|rad|grad|turn)?\s*$/.exec(('' + value).toLowerCase());
        if (!parts || !isFinite(parts[1])) {
          return;
        }
        var factor = (parts[2] === 'grad' ? Math.PI / 200 :
            (parts[2] === 'deg' ? Math.PI / 180 :
            (parts[2] === 'turn' ? 2 * Math.PI : 1)));
        value = +parts[1] * factor;
        break;
      case 'boolean':
        value = !!value && ['false', 'no', 'off'].indexOf(('' + value).toLowerCase()) < 0;
        break;
      case 'booleanOrNumber':
        if ((!value && value !== 0 && value !== '') || ['true', 'false', 'off', 'on', 'no', 'yes'].indexOf(('' + value).toLowerCase()) >= 0) {
          value = !!value && ['false', 'no', 'off'].indexOf(('' + value).toLowerCase()) < 0;
        } else {
          if (!util.isNonNullFinite(value)) {
            return;
          }
          value = +value;
        }
        break;
      case 'coordinate2':
        if (value === '') {
          break;
        }
        if (value && util.isNonNullFinite(value.x) && util.isNonNullFinite(value.y)) {
          value.x = +value.x;
          value.y = +value.y;
          break;
        }
        try { value = JSON.parse(value); } catch (err) { }
        if (value && util.isNonNullFinite(value.x) && util.isNonNullFinite(value.y)) {
          value.x = +value.x;
          value.y = +value.y;
          break;
        }
        if (Array.isArray(value) && util.isNonNullFinite(value[0]) && util.isNonNullFinite(value[1])) {
          value = {x: +value[0], y: +value[1]};
          break;
        }
        parts = /^\s*([-.0-9eE]+)(?:\s+|\s*,)\s*([-.0-9eE]+)\s*$/.exec('' + value);
        if (!parts || !isFinite(parts[1]) || !isFinite(parts[2])) {
          return;
        }
        value = {x: +parts[1], y: +parts[2]};
        break;
      case 'color':
        value = util.convertColor(value);
        if (value === undefined || value.r === undefined) {
          return;
        }
        break;
      case 'number':
        if (!util.isNonNullFinite(value)) {
          return;
        }
        value = +value;
        break;
      case 'numberOrBlank':
        if (value === '') {
          break;
        }
        if (!util.isNonNullFinite(value)) {
          return;
        }
        value = +value;
        break;
      case 'opacity':
        if (value === undefined || value === null || value === '') {
          return;
        }
        value = +value;
        if (isNaN(value) || value < 0 || value > 1) {
          return;
        }
        break;
      case 'positive':
        value = +value;
        if (!isFinite(value) || value <= 0) {
          return;
        }
        break;
      case 'text':
        value = '' + value;
        break;
    }
    return value;
  };

  /**
   * Update layer.
   *
   * @returns {this} The current layer.
   */
  this._update = function () {
    if (m_this.getMTime() > m_buildTime.getMTime()) {
      var labels = this.options('showLabels') ? [] : null;
      /* Interally, we have a set of feature levels (to provide z-index
       * support), each of which can have data from multiple annotations.  We
       * clear the data on each of these features, then build it up from each
       * annotation.  Eventually, it may be necessary to optimize this and
       * only update the features that are changed.
       */
      $.each(m_features, function (idx, featureLevel) {
        $.each(featureLevel, function (type, feature) {
          feature.data = [];
          delete feature.feature.scaleOnZoom;
        });
      });
      $.each(m_annotations, function (annotation_idx, annotation) {
        var features = annotation.features();
        if (labels) {
          var annotationLabel = annotation.labelRecord();
          if (annotationLabel) {
            labels.push(annotationLabel);
          }
        }
        $.each(features, function (idx, featureLevel) {
          if (m_features[idx] === undefined) {
            m_features[idx] = {};
          }
          $.each(featureLevel, function (type, featureSpec) {
            /* Create features as needed */
            if (!m_features[idx][type]) {
              var feature = m_this.createFeature(type, {
                gcs: m_this.map().gcs()
              });
              if (!feature) {
                /* We can't create the desired feature, porbably because of the
                 * selected renderer.  Issue one warning only. */
                var key = 'error_feature_' + type;
                if (!m_this[key]) {
                  console.warn('Cannot create a ' + type + ' feature for ' +
                               'annotations.');
                  m_this[key] = true;
                }
                return;
              }
              /* Since each annotation can have separate styles, the styles are
               * combined together with a meta-style function.  Any style that
               * could be used should be in this list.  Color styles may be
               * restricted to {r, g, b} objects for efficiency, but this
               * hasn't been tested.
               */
              var style = {};
              $.each([
                'closed', 'fill', 'fillColor', 'fillOpacity', 'line',
                'lineCap', 'lineJoin', 'polygon', 'position', 'radius',
                'stroke', 'strokeColor', 'strokeOffset', 'strokeOpacity',
                'strokeWidth', 'uniformPolygon'
              ], function (keyidx, key) {
                var origFunc;
                if (feature.style()[key] !== undefined) {
                  origFunc = feature.style.get(key);
                }
                style[key] = function (d, i, d2, i2) {
                  var style = (
                    (d && d.style) ? d.style : (d && d[2] && d[2].style) ?
                    d[2].style : d2.style);
                  var result = style ? style[key] : d;
                  if (util.isFunction(result)) {
                    result = result(d, i, d2, i2);
                  }
                  if (result === undefined && origFunc) {
                    result = origFunc(d, i, d2, i2);
                  }
                  return result;
                };
              });
              feature.style(style);
              m_features[idx][type] = {
                feature: feature,
                style: style,
                data: []
              };
            }
            /* Collect the data for each feature */
            m_features[idx][type].data.push(featureSpec.data || featureSpec);
            if (featureSpec.scaleOnZoom) {
              m_features[idx][type].feature.scaleOnZoom = true;
            }
          });
        });
      });
      /* Update the data for each feature */
      $.each(m_features, function (idx, featureLevel) {
        $.each(featureLevel, function (type, feature) {
          feature.feature.data(feature.data);
        });
      });
      m_this._updateLabels(labels);
      m_buildTime.modified();
    }
    s_update.call(m_this, arguments);
    return this;
  };

  /**
   * Show or hide annotation labels.  Create or destroy a child layer or a
   * feature as needed.
   *
   * @param {object[]|null} labels The list of labels to display of `null` for
   *    no labels.
   * @returns {this} The class instance.
   */
  this._updateLabels = function (labels) {
    if (!labels || !labels.length) {
      m_this._removeLabelFeature();
      return m_this;
    }
    if (!m_labelFeature) {
      var renderer = registry.rendererForFeatures(['text']);
      if (renderer !== m_this.renderer().api()) {
        m_labelLayer = registry.createLayer('feature', m_this.map(), {renderer: renderer});
        m_this.addChild(m_labelLayer);
        m_labelLayer._update();
        m_this.geoTrigger(geo_event.layerAdd, {
          target: m_this,
          layer: m_labelLayer
        });
      }
      var style = {};
      textFeature.usedStyles.forEach(function (key) {
        style[key] = function (d, i) {
          if (d.style && d.style[key] !== undefined) {
            return d.style[key];
          }
          return (m_this.options('defaultLabelStyle') || {})[key];
        };
      });
      m_labelFeature = (m_labelLayer || m_this).createFeature('text', {
        style: style,
        gcs: m_this.map().gcs(),
        position: function (d) {
          return d.position;
        }
      });
    }
    m_labelFeature.data(labels);
    return m_this;
  };

  /**
   * Check if any features are marked that they need to be updated when a zoom
   * occurs.  If so, mark that feature as modified.
   */
  this._handleZoom = function () {
    var i, features = m_this.features();
    for (i = 0; i < features.length; i += 1) {
      if (features[i].scaleOnZoom) {
        features[i].modified();
      }
    }
  };

  /**
   * Remove the label feature if it exists.
   *
   * @returns {this} The current layer.
   */
  this._removeLabelFeature = function () {
    if (m_labelLayer) {
      m_labelLayer._exit();
      m_this.removeChild(m_labelLayer);
      m_this.geoTrigger(geo_event.layerRemove, {
        target: m_this,
        layer: m_labelLayer
      });
      m_labelLayer = m_labelFeature = null;
    }
    if (m_labelFeature) {
      m_this.removeFeature(m_labelFeature);
      m_labelFeature = null;
    }
    return m_this;
  };

  /**
   * Update if necessary and draw the layer.
   *
   * @returns {this} The current layer.
   */
  this.draw = function () {
    m_this._update();
    s_draw.call(m_this);
    return m_this;
  };

  /**
   * Initialize.
   *
   * @returns {this} The current layer.
   */
  this._init = function () {
    // Call super class init
    s_init.call(m_this);

    if (!m_this.map().interactor()) {
      m_this.map().interactor(mapInteractor({actions: []}));
    }
    m_this.geoOn(geo_event.actionselection, m_this._processAction);
    m_this.geoOn(geo_event.actionmove, m_this._processAction);

    m_this.geoOn(geo_event.mouseclick, m_this._handleMouseClick);
    m_this.geoOn(geo_event.mousemove, m_this._handleMouseMove);

    m_this.geoOn(geo_event.zoom, m_this._handleZoom);

    return m_this;
  };

  /**
   * Free all resources.
   *
   * @returns {this} The current layer.
   */
  this._exit = function () {
    m_this._removeLabelFeature();
    // Call super class exit
    s_exit.call(m_this);
    m_annotations = [];
    m_features = [];
    return m_this;
  };

  return m_this;
};

inherit(annotationLayer, featureLayer);
registry.registerLayer('annotation', annotationLayer);
module.exports = annotationLayer;
