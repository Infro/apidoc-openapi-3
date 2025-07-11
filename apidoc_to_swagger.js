var _ = require('lodash');
var { pathToRegexp } = require('path-to-regexp');
const { debug, log } = require('winston');
// const GenerateSchema = require('generate-schema')
const { mergeSchemas } = require('@fastify/merge-json-schemas');
const GenerateSchema = require('generate-schema')
const { convert, schemaWalker } = require('@openapi-contrib/json-schema-to-openapi-schema');
const das = require('deasync')
const Hjson = require('hjson');

function convertSchema(a, b) {
    let result;
    convert(GenerateSchema.json(a, b)).then(res => { result = res; });
    das.loopWhile(() => result === undefined);
    return result;
}

var swagger = {
    openapi: "3.0.0",
    info: {},
    paths: {}
};

function toSwagger(apidocJson, projectJson) {
    swagger.info = addInfo(projectJson);
    swagger.paths = extractPaths(apidocJson);
    // for (const key in swagger) {
    //     console.log('[%s] %o', key, swagger[key]);
    // }
    swagger.components = {
        securitySchemes: {
            bearerAuth: {
                type: "http",
                scheme: "bearer",
                bearerFormat: "JWT",
            }
        },
        responses: {
            UnauthorizedError: {
                description: "Access token is missing or invalid"
            }
        }
    };
    swagger.security = [{ bearerAuth: [] }];
    return swagger;
}

var tagsRegex = /(<([^>]+)>)/ig;
// Removes <p> </p> tags from text
function removeTags(text) {
    return text ? text.replace(tagsRegex, "") : text;
}

function addInfo(projectJson) {  // cf. https://swagger.io/specification/#info-object
    var info = {};
    info["title"] = projectJson.title || projectJson.name;
    info["version"] = projectJson.version;
    info["description"] = removeTags(projectJson.description);
    return info;
}

/**
 * Extracts paths provided in json format
 * post, patch, put request parameters are extracted in body
 * get and delete are extracted to path parameters
 * @param apidocJson
 * @returns {{}}
 */
function extractPaths(apidocJson) {  // cf. https://swagger.io/specification/#paths-object
    var apiPaths = groupByUrl(apidocJson);
    var paths = {};
    for (var i = 0; i < apiPaths.length; i++) {
        var verbs = apiPaths[i].verbs;
        var url = verbs[0].url;
        var pattern = pathToRegexp(url, null);
        var matches = pattern.exec(url);

        // Surrounds URL parameters with curly brackets -> :email with {email}
        var pathKeys = [];
        for (let j = 1; j < matches.length; j++) {
            var key = matches[j].substring(1);
            url = url.replace(matches[j], "{" + key + "}");
            pathKeys.push(key);
        }

        for (let j = 0; j < verbs.length; j++) {
            var verb = verbs[j];
            var type = verb.type;

            var obj = paths[url] = paths[url] || {};

            _.extend(obj, generateProps(verb))
        }
    }
    return paths;
}


/**
 * apiDocParams
 * @param {type} type
 * @param {boolean} optional
 * @param {string} field
 * @param {string} defaultValue
 * @param {string} description
 */

/**
 * 
 * @param {ApidocParameter[]} apiDocParams 
 * @param {*} parameter 
 */
function transferApidocParamsToSwaggerBody(apiDocParams, parameterInBody) {

    let mountPlaces = {
        '': parameterInBody['schema']
    }

    apiDocParams.forEach(i => {

        const type = i.type ? i.type.toLowerCase() : "string"
        const key = i.field
        const nestedName = createNestedName(i.field)
        const { objectName = '', propertyName } = nestedName

        if (type.endsWith('object[]')) {
            // if schema(parsed from example) doesn't has this constructure, init
            if (!mountPlaces[objectName]['properties'][propertyName]) {
                mountPlaces[objectName]['properties'][propertyName] = { type: 'array', items: { type: 'object', properties: {}, required: [] } }
            }

            // new mount point
            mountPlaces[key] = mountPlaces[objectName]['properties'][propertyName]['items']
        } else if (type.endsWith('[]')) {
            // if schema(parsed from example) doesn't has this constructure, init
            if (!mountPlaces[objectName]['properties'][propertyName]) {
                mountPlaces[objectName]['properties'][propertyName] = {
                    items: {
                        type: type.slice(0, -2), description: removeTags(i.description),
                        // default: i.defaultValue,
                        example: i.defaultValue
                    },
                    type: 'array',
                    ...(i.allowedValues && { enum: i.allowedValues.map(e => e.replace(/^[\s'"`]+|[\s'"`]+$/g, '')) })
                }
            }
        } else if (type === 'object') {
            // if schema(parsed from example) doesn't has this constructure, init
            if (!mountPlaces[objectName]['properties'][propertyName]) {
                // Hack to bypass missing 'object'
                // mountPlaces[objectName]= { type: 'object', properties: {}, required: [] };mountPlaces['']['properties'][objectName] = mountPlaces[objectName]
                mountPlaces[objectName]['properties'][propertyName] = { type: 'object', properties: {}, required: [] }
            }
            // new mount point
            mountPlaces[key] = mountPlaces[objectName]['properties'][propertyName]
        } else {
            mountPlaces[objectName]['properties'][propertyName] = {
                type,
                description: removeTags(i.description),
                default: i.defaultValue,
                ...(i.allowedValues && { enum: i.allowedValues.map(e => e.replace(/^[\s'"`]+|[\s'"`]+$/g, '')) })
            }
        }
        if (!i.optional) {
            // generate-schema forget init [required]
            if (mountPlaces[objectName]['required']) {
                mountPlaces[objectName]['required'].push(propertyName)
            } else {
                mountPlaces[objectName]['required'] = [propertyName]
            }
        }
    })

    return parameterInBody
}

function generateProps(verb) {
    const pathItemObject = {}
    const parameters = generateParameters(verb)
    const body = generateBody(verb)
    const responses = generateResponses(verb)
    if (pathItemObject[verb.type] !== undefined) {
        log.warn('Overwriting existing path item for verb type:', verb.type, 'in URL:', verb.url);
    }
    pathItemObject[verb.type] = {
        // operationId: verb.name,
        tags: [verb.group],
        summary: removeTags(verb.name),
        description: removeTags(verb.title),
        ...((!verb.permission || verb.permission[0].name === 'Public') && { security: [{}] }),
        //security: generateSecurity(verb),
        parameters,
        responses,
    }

    if (body && body.schema && body.schema.properties) {
        if (Object.keys(body.schema.properties).length > 0) // body not empty
            pathItemObject[verb.type.toLowerCase()]["requestBody"] = {
                content: {
                    'application/json': body
                }
            }
    }

    return pathItemObject
}

function generateSecurity(verb) {
    return {
        bearerAuth: [] //verb.permission //Should be an array of roles.
    }
}

function generateBody(verb) {
    // const mixedBody = []

    // if (verb && verb.parameter && verb.parameter.fields) {
    //     const Parameter = verb.parameter.fields.Parameter || []
    //     const _body = verb.parameter.fields.Body || []
    //     mixedBody.push(..._body)
    //     if (!(verb.type === 'get'))  {
    //         mixedBody.push(...Parameter)
    //     }
    // }

    // let body = {}
    // if (verb.type === 'post' || verb.type === 'put') {
    //     body = generateRequestBody(verb, mixedBody)
    // }
    return generateRequestBody(verb, verb && verb.body || [])
}

var groupToOpenApiInType =
{
    "Parameter": "path",
    "Query": "query",
    "Header": "header",
};

function reduceParams(acc, i) {
    if (i.field.indexOf('.') === -1) {
        var item = {
            name: i.field,
            in: groupToOpenApiInType[i.group],
            description: removeTags(i.description),
            required: !i.defaultValue && !i.optional,
            schema: {
                type: i.type ? i.type.toLowerCase() : "string",
                ...(i.type === 'Object' && {
                    properties: {},
                    required: [],
                    ...(i.group == "Query" && { style: 'deepObject', explode: true })
                }),
                ...(i.type.endsWith('[]') && { type: 'array', items: { type: i.type.slice(0, -2).toLowerCase() } }),
                ...(i.default && { default: i.defaultValue }),
                ...(i.allowedValues && { enum: i.allowedValues.map(e => e.replace(/^[\s'"`]+|[\s'"`]+$/g, '')) })
            }
        };
        acc.kvm[item.name] = item;
        acc.params.push(item);
        return acc;
    } else {
        var path = i.field.split('.');
        if (path.length > 2) {
            console.error('Nested path with more than 2 levels is not supported', i.field);
            return acc;
        }
        var propertyName = path.pop();
        var item = {
            description: removeTags(i.description),
            type: i.type ? i.type.toLowerCase() : "string",
            ...(i.default && { default: i.defaultValue }),
            ...(i.allowedValues && { enum: i.allowedValues.map(e => e.replace(/^[\s'"`]+|[\s'"`]+$/g, '')) })
        };
        var objectName = path[0];
        acc.kvm[objectName].schema.properties[propertyName] = item;
        if ((i.defaultValue === undefined) && !i.optional)
            acc.kvm[objectName].schema.required.push(propertyName);
        // acc.params.push();
        return acc;
    }
}

function generateParameters(verb) {
    const mixedQuery = []
    const mixedBody = []
    const header = verb && verb.header && verb.header.fields.Header || []

    // if (verb && verb.parameter && verb.parameter.fields) {
    //     const Parameter = verb.parameter.fields.Parameter || []
    //     const _query = verb.parameter.fields.Query || []
    //     const _body = verb.body || []
    //     mixedQuery.push(..._query)
    //     mixedBody.push(..._body)
    //     if (verb.type === 'get') {
    //         mixedQuery.push(...Parameter)
    //     } else {
    //         mixedBody.push(...Parameter)
    //     }
    // }

    const parameters = [];

    const reducedRouteParams = (verb && verb.parameter && verb.parameter.fields && verb.parameter.fields.Parameter || []).reduce(reduceParams, { kvm: {}, params: [] });
    const reducedHeaderParams = { params: [] };
    // const reducedHeaderParams = (verb && verb.header && verb.header.fields && verb.header.fields.Header || []).reduce(reduceParams, { kvm: {}, params: [] });
    const reducedQueryParams = (verb && verb.query || []).reduce(reduceParams, { kvm: {}, params: [] });

    // parameters.push(...map(mapParamItem));
    // parameters.push(...(verb.query || []).map(mapQueryItem));
    // parameters.push(...(verb && verb.header && verb.header.fields.Header || []).map(mapHeaderItem));

    // return parameters
    return [...reducedRouteParams.params, ...reducedHeaderParams.params, ...reducedQueryParams.params];
}

function generateRequestBody(verb, mixedBody) {
    const bodyParameter = {
        schema: {
            properties: {},
            type: 'object',
            required: []
        }
    }

    if (_.get(verb, 'parameter.examples.length') > 0) {
        for (const example of verb.parameter.examples) {
            const { code, json } = safeParseJson(example.content)
            const schema = convertSchema(example.title, json)
            bodyParameter.schema = mergeSchemas([bodyParameter.schema, schema], {
                mergeArrays: true,
                mergeAdditionalProperties: true
            });
            bodyParameter.description = example.title
        }
    }

    transferApidocParamsToSwaggerBody(mixedBody, bodyParameter)

    return bodyParameter
}

function generateResponses(verb) {
    const success = verb.success
    const responses = {
        200: {
            description: "OK"
        }
    }
    if (success && success.examples && success.examples.length > 0) {
        for (const example of success.examples) {
            const { code, json } = safeParseJson(example.content)
            const existingSchema = responses[code] && responses[code].content && responses[code].content['application/json'] && responses[code].content['application/json'].schema;
            const newSchema = convertSchema(example.title, json);
            const schema = existingSchema && newSchema && mergeSchemas([
                existingSchema,
                newSchema
            ], {
                mergeArrays: true,
                mergeAdditionalProperties: true
            }) || newSchema || existingSchema;

            var description = removeTags(example.title);
            description = false
                || (description.length === 0 && responses[code] && responses[code].description)
                || (description.length > 0 && responses[code] && responses[code].description && description + '\n' + responses[code].description)
                || (responses[code] && responses[code].description)
                || description;
            responses[code] = {
                ...(schema && {
                    content: {
                        'application/json': {
                            schema: schema
                        }
                    }
                }),
                description: description
            };
        }
    }

    mountResponseSpecSchema(verb, responses)

    return responses
}

function mountResponseSpecSchema(verb, responses) {
    // if (verb.success && verb.success['fields'] && verb.success['fields']['Success 200']) {
    if (_.get(verb, 'success.fields.Success 200')) {
        const apidocParams = verb.success['fields']['Success 200']
        //responses[200] = transferApidocParamsToSwaggerBody(apidocParams, responses[200])
    }
}

function safeParseJson(content) {
    // such as  'HTTP/1.1 200 OK\n' +  '{\n' + ...

    let startingIndex = 0;
    for (let i = 0; i < content.length; i++) {
        const character = content[i];
        if (character === '{' || character === '[') {
            startingIndex = i;
            break;
        }
    }

    const mayCodeString = content.slice(0, startingIndex)
    const mayContentString = content.slice(startingIndex)

    const mayCodeSplit = mayCodeString.trim().split(' ')
    const code = mayCodeSplit.length === 3 ? parseInt(mayCodeSplit[1]) : 200

    let json = {}
    try {
        json = Hjson.parse(mayContentString)
    } catch (error) {
        console.warn(`Parse Error:\n\t${error}\n\tUsing: "${mayContentString}"`);//        console.warn(content)
    }

    return {
        code,
        json
    }
}
function createNestedName(field, defaultObjectName) {
    let propertyName = field;
    let objectName;
    let propertyNames = field.split(".");
    if (propertyNames && propertyNames.length > 1) {
        propertyName = propertyNames.pop();
        objectName = propertyNames.join(".");
    }

    return {
        propertyName: propertyName,
        objectName: objectName || defaultObjectName
    }
}

function groupByUrl(apidocJson) {
    return _.chain(apidocJson)
        .groupBy("url")
        .toPairs()
        .map(function (element) {
            return _.zipObject(["url", "verbs"], element);
        })
        .value();
}

module.exports = {
    toSwagger: toSwagger
};
