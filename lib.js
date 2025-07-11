const fs = require('fs')
const path = require('path')
const apidoc = require('apidoc')
const winston = require('winston');

const apidoc_to_swagger = require('./apidoc_to_swagger');


function generateLog(options) {
    return winston.createLogger({
        transports: [
            new (winston.transports.Console)({
                level: options.verbose ? 'verbose' : 'info',
                silent: false,
                prettyPrint: true,
                colorize: options.color,
                timestamp: false
            }),
        ]
    })
}

function main(options) {
    options.verbose && console.log('options', options);
    const log = generateLog(options)
    const { src, dest, verbose } = options

    var api = apidoc.createDoc(options);

    var apidocData = JSON.parse(api.data);
    var projectData = JSON.parse(api.project);

    // Replicate underscoreToSpace handlebar filter from https://github.com/apidoc/apidoc/blob/0.50.5/template/src/hb_helpers.js#L93
    for (let article of apidocData) {
        if (article.name)
            article.name = article.name.replace(/(_+)/g, ' ');
    }

    const swagger = apidoc_to_swagger.toSwagger(apidocData, projectData)

    var hack = JSON.stringify(swagger);
    hack = hack.replace(/,"required":\[\]/g, '')
        .replace(/"type":"date"/g, '"type":"string","format":"date-time"')
        .replace(/"type":"file"/g, '"type":"string","format":"binary"');
    api["swaggerData"] = hack;
    createOutputFile(api.swaggerData, log, options)

    return swagger;
}

function createOutputFile(swaggerData, log, options) {
    if (options.simulate)
        log.warn('!!! Simulation !!! No file or dir will be copied or created.');

    log.verbose('create dir: ' + options.dest);
    if (!options.simulate)
        fs.existsSync(options.dest) || fs.mkdirSync(options.dest);

    //Write swagger
    log.verbose('write swagger json file: ' + options.dest + 'swagger.json');
    if (!options.simulate)
        fs.writeFileSync(options.dest + '/swagger.json', swaggerData);
}

exports.main = main