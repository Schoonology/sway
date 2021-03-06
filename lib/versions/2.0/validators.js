/*
 * The MIT License (MIT)
 *
 * Copyright (c) 2015 Apigee Corporation
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

'use strict';

var _ = require('lodash');
var customFormatValidators = require('./format-validators');
var helpers = require('../../helpers');
var JsonRefs = require('json-refs');
var swaggerSchema = require('./schema.json');
var vHelpers = require('./helpers');

function getSchemaProperties (schema) {
  var properties = _.keys(schema.properties); // Start with the defined properties

  // Add properties defined in the parent
  _.forEach(schema.allOf, function (parent) {
    _.forEach(getSchemaProperties(parent), function (property) {
      if (_.indexOf(properties, property) === -1) {
        properties.push(property);
      }
    });
  });

  return properties;
}

function walkSchema (api, blacklist, schema, path, handlers, response) {
  var type = schema.type || 'object';

  function shouldSkip (cPath) {
    return _.indexOf(blacklist, JsonRefs.pathToPointer(cPath)) > -1;
  }

  // Do not process items in the blacklist as they've been processed already
  if (shouldSkip(path)) {
    return;
  }

  function walker (pSchema, pPath) {
    // Do not process items in the blacklist as they've been processed already
    if (shouldSkip(pPath)) {
      return;
    }

    _.forEach(pSchema, function (item, name) {
      if (_.isNumber(name)) {
        name = name.toString();
      }

      walkSchema(api, blacklist, item, pPath.concat(name), handlers, response);
    });

    _.forEach(handlers, function (handler) {
      handler(api, response, pSchema, pPath);
    });
  }

  if (!_.isUndefined(schema.schema)) {
    walkSchema(api, blacklist, schema.schema, path.concat('schema'), handlers, response);
  } else if (type === 'array' && !_.isUndefined(schema.items)) {
    walker(schema.items, path.concat('items'));
  } else if (type === 'object') {
    if (!_.isUndefined(schema.additionalProperties)) {
      walkSchema(api, blacklist, schema.additionalProperties, path.concat('additionalProperties'), handlers, response);
    }

    _.forEach(['allOf', 'properties'], function (propName) {
      if (!_.isUndefined(schema[propName])) {
        walker(schema[propName], path.concat(propName));
      }
    });
  }

  _.forEach(handlers, function (handler) {
    handler(api, response, schema, path);
  });
}

/**
 * Validates the resolved Swagger document against the Swagger 2.0 JSON Schema.
 *
 * @param {SwaggerApi} api - The SwaggerApi object
 *
 * @returns {object} Object containing the errors and warnings of the validation
 */
function validateStructure (api) {
  return helpers.validateAgainstSchema(helpers.createJSONValidator({
    formatValidators: customFormatValidators
  }), swaggerSchema, api.resolved);
}

/* Schema Object Validators */

function validateArrayTypeItemsExistence (api, response, schema, path) {
  if (schema.type === 'array' && _.isUndefined(schema.items)) {
    response.errors.push({
      code: 'OBJECT_MISSING_REQUIRED_PROPERTY',
      message: 'Missing required property: items',
      path: path
    });
  }
}

function validateDefaultValue (api, response, schema, path) {
  var result;

  if (!_.isUndefined(schema.default)) {
    result = helpers.validateAgainstSchema(helpers.createJSONValidator({
      formatValidators: customFormatValidators
    }), schema, schema.default);

    _.forEach(result.errors, function (error) {
      error.path = path.concat(error.path.concat('default'));

      response.errors.push(error);
    });

    _.forEach(result.warnings, function (warning) {
      warning.path = path.concat(warning.path.push('default'));

      response.warnings.push(warning);
    });
  }
}

function validateSchemaProperties (api, response, schema, path) {
  _.forEach(_.difference(schema.required || [], getSchemaProperties(schema)), function (name) {
    response.errors.push({
      code: 'OBJECT_MISSING_REQUIRED_PROPERTY_DEFINITION',
      message: 'Missing required property definition: ' + name,
      path: path
    });
  });
}

/**
 * Validates all references.
 *
 * * Identifies circular inheritance references
 * * Identifies unreferenced referenceable definitions
 * * Identifies unresolvable references
 *
 * @param {SwaggerApi} api - The SwaggerApi object
 *
 * @returns {object} Object containing the errors and warnings of the validation
 */
function validateReferences (api) {
  var referenceable = [];
  var references = {};
  var response = {
    errors: [],
    warnings: []
  };

  function addReference (ref, ptr) {
    if (_.indexOf(references, ref) === -1) {
      if (_.isUndefined(references[ref])) {
        references[ref] = [];
      }

      // Add references to ancestors
      if (ref.indexOf('allOf') > -1) {
        addReference(ref.substring(0, ref.lastIndexOf('/allOf')));
      }

      references[ref].push(ptr);
    }
  }

  function createSecurityProcessor (path) {
    return function (security, index) {
      _.forEach(security, function (scopes, name) {
        var sdPath = ['securityDefinitions', name];
        var sdPtr = JsonRefs.pathToPointer(sdPath);
        var srPath = path.concat([index.toString(), name]);

        // Identify missing reference to the security definition
        if (_.indexOf(referenceable, sdPtr) === -1) {
          response.errors.push({
            code: 'UNRESOLVABLE_REFERENCE',
            message: 'Security definition could not be resolved: ' + name,
            path: srPath
          });
        } else {
          addReference(sdPtr, JsonRefs.pathToPointer(srPath));

          _.forEach(scopes, function (scope, sIndex) {
            var ssrPath = srPath.concat(sIndex.toString());
            var ssrPtr = JsonRefs.pathToPointer(sdPath.concat(['scopes', scope]));

            if (_.indexOf(referenceable, ssrPtr) === -1) {
              response.errors.push({
                code: 'UNRESOLVABLE_REFERENCE',
                message: 'Security scope definition could not be resolved: ' + scope,
                path: ssrPath
              });
            } else {
              addReference(JsonRefs.pathToPointer(sdPath.concat(['scopes', scope])), ssrPtr);
            }
          });
        }
      });
    };
  }

  // Identify referenceable definitions
  _.forEach(api.resolved.definitions, function (def, name) {
    referenceable.push(JsonRefs.pathToPointer(['definitions', name]));
  });

  _.forEach(api.resolved.parameters, function (def, name) {
    referenceable.push(JsonRefs.pathToPointer(['parameters', name]));
  });

  _.forEach(api.resolved.responses, function (def, name) {
    referenceable.push(JsonRefs.pathToPointer(['responses', name]));
  });

  _.forEach(api.resolved.securityDefinitions, function (def, name) {
    var sPath = ['securityDefinitions', name];

    referenceable.push(JsonRefs.pathToPointer(sPath));

    _.forEach(def.scopes, function (description, scope) {
      var ptr = JsonRefs.pathToPointer(sPath.concat(['scopes', scope]));

      if (_.indexOf(referenceable, ptr) === -1) {
        referenceable.push(ptr);
      }
    });
  });

  // Identify references and validate circular inheritance and missing references for JSON References
  _.forEach(api.references, function (metadata, ptr) {
    var realPath = JsonRefs.pathFromPointer(ptr).concat('$ref');
    var realPtr = JsonRefs.pathToPointer(realPath);
    var err;

    if (_.has(metadata, 'missing')) {
      err = {
        code: 'UNRESOLVABLE_REFERENCE',
        message: 'Reference could not be resolved: ' + metadata.ref,
        path: realPath
      };

      if (_.has(metadata, 'err')) {
        err.err = metadata.err;
      }

      response.errors.push(err);
    } else {
      if (metadata.circular && ptr.indexOf('allOf') > -1) {
        response.errors.push({
          code: 'CIRCULAR_INHERITANCE',
          message: 'Schema object inherits from itself: ' + metadata.ref,
          path: realPath
        });
      }

      addReference(metadata.ref, realPtr);
    }
  });

  // Identify references and validate missing references for non-JSON References (security)
  _.forEach(api.resolved.security, createSecurityProcessor(['security']));

  _.forEach(api.resolved.paths, function (pathDef, name) {
    var pPath = ['paths', name];

    _.forEach(pathDef.security, createSecurityProcessor(pPath.concat('security')));

    _.forEach(pathDef, function (operationDef, method) {
      // Do not process non-operations
      if (_.indexOf(vHelpers.supportedHttpMethods, method) === -1) {
        return;
      }

      _.forEach(operationDef.security,
                createSecurityProcessor(pPath.concat([method, 'security'])));
    });
  });

  // Identify unused references (missing references are already handled above)
  _.forEach(_.difference(referenceable, Object.keys(references)), function (ptr) {
    response.warnings.push({
      code: 'UNUSED_DEFINITION',
      message: 'Definition is not used: ' + ptr,
      path: JsonRefs.pathFromPointer(ptr)
    });
  });

  return response;
}

/**
 * Validates all schema objects and schema-like objects (non-body path parameters).
 *
 * * Validates circular references related to composition/inheritance
 * * Validates that all array types have their required items property
 *     (@see {@link https://github.com/swagger-api/swagger-spec/issues/174})
 * * Validates that all default values are valid based on its respective schema
 *
 * @param {SwaggerApi} api - The SwaggerApi object
 *
 * @returns {object} Object containing the errors and warnings of the validation
 */
function validateSchemaObjects (api) {
  // Build a blacklist to avoid cascading errors/warnings
  var blacklist = _.reduce(api.references, function (list, metadata, ptr) {
    var refPath = JsonRefs.pathFromPointer(ptr);

    list.push(JsonRefs.pathToPointer(refPath));

    return list;
  }, []);
  var response = {
    errors: [],
    warnings: []
  };
  var validators = [
    validateArrayTypeItemsExistence,
    validateDefaultValue,
    validateSchemaProperties
  ];

  function validateParameters (parameters, path) {
    _.forEach(parameters, function (parameterDef, name) {
      var pPath;

      if (_.isNumber(name)) {
        name = name.toString();
      }

      pPath = path.concat(name);

      // Create JSON Schema for non-body parameters
      if (parameterDef.in !== 'body') {
        parameterDef = vHelpers.getParameterSchema(parameterDef);
      }

      walkSchema(api, blacklist, parameterDef, pPath, validators, response);
    });
  }

  function validateResponses (responses, path) {
    _.forEach(responses, function (responseDef, name) {
      var rPath = path.concat(name);

      _.forEach(responseDef.headers, function (header, hName) {
        walkSchema(api, blacklist, header, rPath.concat(['headers', hName]), validators, response);
      });

      if (!_.isUndefined(responseDef.schema)) {
        walkSchema(api, blacklist, responseDef.schema, rPath.concat('schema'), validators, response);
      }
    });
  }

  // Validate definitions
  _.forEach(api.resolved.definitions, function (definitionDef, name) {
    walkSchema(api, blacklist, definitionDef, ['definitions', name], validators, response);
  });

  // Validate global parameter definitions
  validateParameters(api.resolved.parameters, ['parameters']);

  // Validate global response definitions
  validateResponses(api.resolved.responses, ['responses']);

  // Validate paths and operations
  _.forEach(api.resolved.paths, function (pathDef, path) {
    var pPath = ['paths', path];

    // Validate path-level parameter definitions
    validateParameters(pathDef.parameters, pPath.concat('parameters'));

    _.forEach(pathDef, function (operationDef, method) {
      var oPath = pPath.concat(method);

      // Do not process non-operations
      if (_.indexOf(vHelpers.supportedHttpMethods, method) === -1) {
        return;
      }

      // Validate operation parameter definitions
      validateParameters(operationDef.parameters, oPath.concat('parameters'));

      // Validate operation response definitions
      validateResponses(operationDef.responses, oPath.concat('responses'));
    });
  });

  return response;
}

/**
 * Validates paths and operations (Written as one validator to avoid multiple passes)
 *
 * * Ensure that path parameters are defined for each path parameter declaration
 * * Ensure that defined path parameters match a declared path parameter
 * * Ensure that paths are functionally different
 * * Ensure that an operation only has one body parameter
 * * Ensure that an operation has only a body or formData parameter but not both
 * * Ensure that all operation parameters are unique (in + name)
 * * Ensure that all operation ids are unique
 *
 * @param {SwaggerApi} api - The SwaggerApi object
 *
 * @returns {object} Object containing the errors and warnings of the validation
 */
function validatePathsAndOperations (api) {
  var response = {
    errors: [],
    warnings: []
  };

  function validateDuplicateParameter (seenParameters, parameter, path) {
    var pName = parameter.in + ':' + parameter.name;

    // Identify duplicate parameter names
    if (_.indexOf(seenParameters, pName) > -1) {
      response.errors.push({
        code: 'DUPLICATE_PARAMETER',
        message: 'Operation cannot have duplicate parameters: ' + JsonRefs.pathToPointer(path),
        path: path
      });
    } else {
      seenParameters.push(pName);
    }

    return seenParameters;
  }

  _.reduce(api.resolved.paths, function (metadata, pathDef, path) {
    var declaredPathParameters = [];
    var normalizedPath = path;
    var pPath = ['paths', path];

    _.forEach(path.match(/\{(.*?)\}/g), function (arg, index) {
      // Record the path parameter name
      declaredPathParameters.push(arg.replace(/[{}]/g, ''));

      // Update the normalized path
      normalizedPath = normalizedPath.replace(arg, 'arg' + index);
    });

    // Idenfity paths that are functionally the same
    if (_.indexOf(metadata.paths, normalizedPath) > -1) {
      response.errors.push({
        code: 'EQUIVALENT_PATH',
        message: 'Equivalent path already exists: ' + path,
        path: pPath
      });
    } else {
      metadata.paths.push(normalizedPath);
    }

    // Identify duplicate path-level parameters (We do this manually since SwaggerApi#getOperation consolidates them)
    _.reduce(pathDef.parameters, function (seenParameters, parameter, index) {
      return validateDuplicateParameter(seenParameters, parameter, pPath.concat(['parameters', index.toString()]));
    }, []);

    _.forEach(pathDef, function (operationDef, method) {
      var definedPathParameters = {};
      var oPath = pPath.concat(method);
      var operationId = operationDef.operationId;
      var pathMetadata;
      var parameters;

      // Do not process non-operations
      if (_.indexOf(vHelpers.supportedHttpMethods, method) === -1) {
        return;
      }

      // Identify duplicate operationIds
      if (!_.isUndefined(operationId)) {
        if (_.indexOf(metadata.operationIds, operationId) !== -1) {
          response.errors.push({
            code: 'DUPLICATE_OPERATIONID',
            message: 'Cannot have multiple operations with the same operationId: ' + operationId,
            path: oPath.concat(['operationId'])
          });
        } else {
          metadata.operationIds.push(operationId);
        }
      }

      // Identify duplicate operation-level parameters (We do this manually for the same reasons above)
      _.reduce(operationDef.parameters, function (seenParameters, parameter, index) {
        return validateDuplicateParameter(seenParameters, parameter, oPath.concat(['parameters', index.toString()]));
      }, []);

      // Use SwaggerApi#getOperation to avoid having to consolidate parameters
      parameters = api.getOperation(path, method).getParameters();

      pathMetadata = _.reduce(parameters, function (pMetadata, parameter) {
        // Record path parameters
        if (parameter.in === 'path') {
          definedPathParameters[parameter.name] = parameter.ptr;
        } else if (parameter.in === 'body') {
          pMetadata.bodyParameteters += 1;
        } else if (parameter.in === 'formData') {
          pMetadata.formParameters += 1;
        }

        return pMetadata;
      }, {bodyParameteters: 0, formParameters: 0});

      // Identify multiple body parameters
      if (pathMetadata.bodyParameteters > 1) {
        response.errors.push({
          code: 'MULTIPLE_BODY_PARAMETERS',
          message: 'Operation cannot have multiple body parameters',
          path: oPath
        });
      }

      // Identify having both a body and a form parameter
      if (pathMetadata.bodyParameteters > 0 && pathMetadata.formParameters > 0) {
        response.errors.push({
          code: 'INVALID_PARAMETER_COMBINATION',
          message: 'Operation cannot have a body parameter and a formData parameter',
          path: oPath
        });
      }

      // Identify undefined path parameters
      _.forEach(_.difference(declaredPathParameters, _.keys(definedPathParameters)), function (name) {
        response.errors.push({
          code: 'MISSING_PATH_PARAMETER_DEFINITION',
          message: 'Path parameter is declared but is not defined: ' + name,
          path: oPath
        });
      });

      // Identify undeclared path parameters
      _.forEach(_.difference(_.keys(definedPathParameters), declaredPathParameters), function (name) {
        response.errors.push({
          code: 'MISSING_PATH_PARAMETER_DECLARATION',
          message: 'Path parameter is defined but is not declared: ' + name,
          path: JsonRefs.pathFromPointer(definedPathParameters[name])
        });
      });
    });

    return metadata;
  }, {paths: [], operationIds: []});

  return response;
}

module.exports = {
  jsonSchemaValidator: validateStructure,
  semanticValidators: [
    validateReferences,
    validateSchemaObjects,
    validatePathsAndOperations
  ]
};
