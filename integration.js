'use strict';

const request = require('postman-request');
const config = require('./config/config');
const async = require('async');
const fs = require('fs');
const xml2js = require('xml2js');

let Logger;
let requestWithDefaults;

const MAX_PARALLEL_LOOKUPS = 10;

/**
 *
 * @param entities
 * @param options
 * @param cb
 */
function startup(logger) {
  let defaults = {};
  Logger = logger;

  const { cert, key, passphrase, ca, proxy, rejectUnauthorized } = config.request;

  if (typeof cert === 'string' && cert.length > 0) {
    defaults.cert = fs.readFileSync(cert);
  }

  if (typeof key === 'string' && key.length > 0) {
    defaults.key = fs.readFileSync(key);
  }

  if (typeof passphrase === 'string' && passphrase.length > 0) {
    defaults.passphrase = passphrase;
  }

  if (typeof ca === 'string' && ca.length > 0) {
    defaults.ca = fs.readFileSync(ca);
  }

  if (typeof proxy === 'string' && proxy.length > 0) {
    defaults.proxy = proxy;
  }

  if (typeof rejectUnauthorized === 'boolean') {
    defaults.rejectUnauthorized = rejectUnauthorized;
  }

  requestWithDefaults = request.defaults(defaults);
}

function doLookup(entities, options, cb) {
  let lookupResults = [];
  let tasks = [];

  Logger.debug(entities);

  entities.forEach((entity) => {
    let [npa, nxx, line] = entity.value.split(/[()-.]/).reduce((accum, token) => {
      if (token.trim().length > 0) {
        accum.push(token.trim());
      }
      return accum;
    }, []);

    // Validate the npa and nxx values and skip the entity if it is not a valid value
    // NPA must be between 201 and 999.
    // NXX must be between 200 and 999.
    if (npa < 201 || npa > 999 || nxx < 200 || nxx > 999) {
      return;
    }

    let requestOptions = {
      method: 'GET',
      uri: 'https://localcallingguide.com/xmlprefix.php',
      qs: { npa, nxx }
    };

    Logger.trace({ uri: requestOptions }, 'Request URI');

    tasks.push(function(done) {
      requestWithDefaults(requestOptions, function(error, res, body) {
        if (error) {
          return done({
            detail: 'HTTP Request Error',
            error
          });
        }

        Logger.trace({ body, statusCode: res ? res.statusCode : 'N/A' }, 'Result of Lookup');

        if (res.statusCode === 200) {
          done(null, {
            entity,
            body,
            displayValue: `${npa}-${nxx}-${line}`
          });
        } else {
          return done({
            err: 'Server Error',
            detail: 'Unexpected Server Error',
            body
          });
        }
      });
    });
  });

  async.parallelLimit(tasks, MAX_PARALLEL_LOOKUPS, (err, results) => {
    if (err) {
      Logger.error({ err }, 'Error executing HTTP Requests');
      return cb(err);
    }

    const error = {
      errors: []
    };

    for (let result of results) {
      if (result.body === null || result.body.length === 0) {
        lookupResults.push({
          entity: result.entity,
          data: null
        });
      } else {
        xml2js.parseString(result.body, function(err, parsedObject) {
          Logger.trace({ parsedObject }, 'Result of Lookup Parsed');
          if (typeof parsedObject.root && parsedObject.root.error) {
            // We found a result with an error so we add this error to our list of error objects
            error.errors.push({
              detail: Array.isArray(parsedObject.root.error) ? parsedObject.root.error[0] : parsedObject.root.error,
              phoneNumber: result.entity.value
            });
          } else if (typeof parsedObject.root === 'undefined' || typeof parsedObject.root.prefixdata === 'undefined') {
            lookupResults.push({
              entity: result.entity,
              data: null
            });
          } else {
            lookupResults.push({
              entity: result.entity,
              //displayValue: result.displayValue,
              data: {
                summary: [], // summary fields added via custom component
                details: parsedObject
              }
            });
          }
        });
      }
    }

    Logger.debug({ lookupResults }, 'Results');
    cb(error.errors.length > 0 ? error : null, lookupResults);
  });
}

module.exports = {
  doLookup,
  startup
};
