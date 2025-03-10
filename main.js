/* jshint -W097 */
/* jshint -W030 */
/* jshint strict:true */
/* jslint node: true */
/* jslint esversion: 6 */
'use strict';

const utils = require('@iobroker/adapter-core'); // Get common adapter utils
let adapter;

const objectHelper = require('@apollon/iobroker-tools').objectHelper; // Get common adapter utils
const mapper = require('./lib/mapper'); // Get common adapter utils
const dgram = require('dgram');
const {MessageParser, CommandType} = require('tuyapi/lib/message-parser.js');
const extend = require('extend');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const http = require('http');
const serveStatic = require('serve-static');
const finalhandler = require('finalhandler');
let mitm;

const crypto = require('crypto');
const UDP_KEY_STRING = 'yGAdlopoPVldABfn';
const UDP_KEY = crypto.createHash('md5').update(UDP_KEY_STRING, 'utf8').digest();

let server;
let serverEncrypted;
let proxyServer;
let staticServer;
let proxyStopTimeout;
let proxyAdminMessageCallback;

const TuyaDevice = require('tuyapi');

const knownDevices = {};
let discoveredEncryptedDevices = {};
const valueHandler = {};
let connected = null;
let connectedCount = 0;
let adapterInitDone = false;

let Sentry;
let SentryIntegrations;
function initSentry(callback) {
    if (!adapter.ioPack.common || !adapter.ioPack.common.plugins || !adapter.ioPack.common.plugins.sentry) {
        return callback && callback();
    }
    const sentryConfig = adapter.ioPack.common.plugins.sentry;
    if (!sentryConfig.dsn) {
        adapter.log.warn('Invalid Sentry definition, no dsn provided. Disable error reporting');
        return callback && callback();
    }
    // Require needed tooling
    Sentry = require('@sentry/node');
    SentryIntegrations = require('@sentry/integrations');
    // By installing source map support, we get the original source
    // locations in error messages
    require('source-map-support').install();

    let sentryPathWhitelist = [];
    if (sentryConfig.pathWhitelist && Array.isArray(sentryConfig.pathWhitelist)) {
        sentryPathWhitelist = sentryConfig.pathWhitelist;
    }
    if (adapter.pack.name && !sentryPathWhitelist.includes(adapter.pack.name)) {
        sentryPathWhitelist.push(adapter.pack.name);
    }
    let sentryErrorBlacklist = [];
    if (sentryConfig.errorBlacklist && Array.isArray(sentryConfig.errorBlacklist)) {
        sentryErrorBlacklist = sentryConfig.errorBlacklist;
    }
    if (!sentryErrorBlacklist.includes('SyntaxError')) {
        sentryErrorBlacklist.push('SyntaxError');
    }

    Sentry.init({
        release: `${adapter.pack.name}@${adapter.pack.version}`,
        dsn: sentryConfig.dsn,
        integrations: [
            new SentryIntegrations.Dedupe()
        ]
    });
    Sentry.configureScope(scope => {
        scope.setTag('version', adapter.common.installedVersion || adapter.common.version);
        if (adapter.common.installedFrom) {
            scope.setTag('installedFrom', adapter.common.installedFrom);
        }
        else {
            scope.setTag('installedFrom', adapter.common.installedVersion || adapter.common.version);
        }
        scope.addEventProcessor(function(event, hint) {
            // Try to filter out some events
            if (event.exception && event.exception.values && event.exception.values[0]) {
                const eventData = event.exception.values[0];
                // if error type is one from blacklist we ignore this error
                if (eventData.type && sentryErrorBlacklist.includes(eventData.type)) {
                    return null;
                }
                if (eventData.stacktrace && eventData.stacktrace.frames && Array.isArray(eventData.stacktrace.frames) && eventData.stacktrace.frames.length) {
                    // if last exception frame is from an nodejs internal method we ignore this error
                    if (eventData.stacktrace.frames[eventData.stacktrace.frames.length - 1].filename && (eventData.stacktrace.frames[eventData.stacktrace.frames.length - 1].filename.startsWith('internal/') || eventData.stacktrace.frames[eventData.stacktrace.frames.length - 1].filename.startsWith('Module.'))) {
                        return null;
                    }
                    // Check if any entry is whitelisted from pathWhitelist
                    const whitelisted = eventData.stacktrace.frames.find(frame => {
                        if (frame.function && frame.function.startsWith('Module.')) {
                            return false;
                        }
                        if (frame.filename && frame.filename.startsWith('internal/')) {
                            return false;
                        }
                        if (frame.filename && !sentryPathWhitelist.find(path => path && path.length && frame.filename.includes(path))) {
                            return false;
                        }
                        return true;
                    });
                    if (!whitelisted) {
                        return null;
                    }
                }
            }

            return event;
        });

        adapter.getForeignObject('system.config', (err, obj) => {
            if (obj && obj.common && obj.common.diag !== 'none') {
                adapter.getForeignObject('system.meta.uuid', (err, obj) => {
                    // create uuid
                    if (!err  && obj) {
                        Sentry.configureScope(scope => {
                            scope.setUser({
                                id: obj.native.uuid
                            });
                        });
                    }
                    callback && callback();
                });
            }
            else {
                callback && callback();
            }
        });
    });
}

function setConnected(isConnected) {
    if (connected !== isConnected) {
        connected = isConnected;
        adapter && adapter.setState('info.connection', connected, true, (err) => {
            // analyse if the state could be set (because of permissions)
            if (err && adapter && adapter.log) adapter.log.error(`Can not update connected state: ${err}`);
            else if (adapter && adapter.log) adapter.log.debug(`connected set to ${connected}`);
        });
    }
}

function startAdapter(options) {
    options = options || {};
    Object.assign(options, {
        name: 'tuya'
    });
    adapter = new utils.Adapter(options);

    adapter.on('unload', function(callback) {
        try {
            stopAll();
            stopProxy();
            setConnected(false);
            // adapter.log.info('cleaned everything up...');
            setTimeout(callback, 3000);
        } catch (e) {
            callback();
        }
    });

    adapter.on('stateChange', function(id, state) {
        // Warning, state can be null if it was deleted
        adapter.log.debug(`stateChange ${id} ${JSON.stringify(state)}`);
        objectHelper.handleStateChange(id, state);
    });

    adapter.on('message', function(msg) {
        processMessage(msg);
    });

    adapter.on('ready', function() {
        if (adapter.supportsFeature && adapter.supportsFeature('PLUGINS')) {
            const sentryInstance = adapter.getPluginInstance('sentry');
            if (sentryInstance) {
                Sentry = sentryInstance.getSentryObject();
            }
            main();
        }
        else {
            initSentry(main);
        }
    });
    return adapter;
}

function stopAll() {
    if (server) {
        try {
            server.close();
        } catch (e) {
            // ignore
        }
    }
    server = null;
    if (serverEncrypted) {
        try {
            serverEncrypted.close();
        } catch (e) {
            // ignore
        }
    }
    serverEncrypted = null;
    if (proxyStopTimeout) {
        clearTimeout(proxyStopTimeout);
        proxyStopTimeout = null;
    }
    for (const deviceId in knownDevices) {
        if (!knownDevices.hasOwnProperty(deviceId)) continue;
        knownDevices[deviceId].stop = true;
        if (knownDevices[deviceId].reconnectTimeout) {
            clearTimeout(knownDevices[deviceId].reconnectTimeout);
            knownDevices[deviceId].reconnectTimeout = null;
        }
        if (knownDevices[deviceId].pollingTimeout) {
            clearTimeout(knownDevices[deviceId].pollingTimeout);
            knownDevices[deviceId].pollingTimeout = null;
        }
        if (knownDevices[deviceId].device) {
            knownDevices[deviceId].device.disconnect();
            knownDevices[deviceId].device = null;
        }
        if (discoveredEncryptedDevices[knownDevices[deviceId].ip]) {
            discoveredEncryptedDevices[knownDevices[deviceId].ip] = false;
        }
    }
}

function initDeviceObjects(deviceId, data, objs, values, preserveFields) {
    if (!values) {
        values = {};
    }
    if (!preserveFields) {
        preserveFields = [];
    }
    const dpIdList = [];
    const physicalDeviceId = data.meshId || deviceId;
    objs.forEach((obj) => {
        const id = obj.id;
        dpIdList.push(id);
        delete obj.id;
        let onChange;
        if (!data.localKey && !data.meshId) {
            obj.write = false;
        }
        if (obj.write) {
            adapter.log.debug(`${deviceId} Register onChange for ${id}`);
            onChange = (value) => {
                adapter.log.debug(`${deviceId} onChange triggered for ${id} and value ${JSON.stringify(value)}`);
                if (!knownDevices[physicalDeviceId] || !knownDevices[physicalDeviceId].device) {
                    adapter.log.debug(`${deviceId} Device communication not initialized ...`);
                    return;
                }

                if (obj.scale) {
                    value *= Math.pow(10, obj.scale);
                }
                else if (obj.states) {
                    value = obj.states[value.toString()];
                }

                knownDevices[physicalDeviceId].device.set({
                    'dps': id,
                    'set': value,
                    'devId': deviceId
                }).then(() => {
                    adapter.log.debug(`${deviceId}.${id}: set value ${value} via ${physicalDeviceId}`);
                    pollDevice(deviceId, 2000);
                }).catch((err) => {
                    adapter.log.error(`${deviceId}.${id}: ${err.message}`);
                    pollDevice(deviceId, 2000);
                });
            };
        }
        if (obj.scale) {
            valueHandler[`${deviceId}.${id}`] = (value) => {
                if (value === undefined) return undefined;
                return Math.floor(value * Math.pow(10, -obj.scale) * 100) / 100;
            };
            values[id] = valueHandler[`${deviceId}.${id}`](values[id]);
        }
        else if (obj.states) {
            valueHandler[`${deviceId}.${id}`] = (value) => {
                if (value === undefined) return undefined;
                for (const key in obj.states) {
                    if (!obj.states.hasOwnProperty(key)) continue;
                    if (obj.states[key] === value) return parseInt(key);
                }
                adapter.log.warn(`${deviceId}.${id}: Value from device not defined in Schema: ${value}`);
                return null;
            };
            values[id] = valueHandler[`${deviceId}.${id}`](values[id]);
        }
        if (obj.encoding) {
            const dpEncoding = obj.encoding;
            if (!valueHandler[`${deviceId}.${id}`]) {
                valueHandler[`${deviceId}.${id}`] = (value) => {
                    if (typeof value !== 'string') return value;
                    try {
                        switch (dpEncoding) {
                            case 'base64':
                                return Buffer.from(value, 'base64').toString('utf-8');
                            default:
                                adapter.log.info(`Unsupported encoding ${dpEncoding} for ${deviceId}.${id}`);
                                return value;
                        }
                    } catch (err) {
                        adapter.log.info(`Error while decoding ${dpEncoding} for ${deviceId}.${id}: ${err.message}`);
                        return value;
                    }
                };
                values[id] = valueHandler[`${deviceId}.${id}`](values[id]);
            }
            delete obj.encoding;
        }
        objectHelper.setOrUpdateObject(`${deviceId}.${id}`, {
            type: 'state',
            common: obj
        }, preserveFields, values[id], onChange);
    });
    return dpIdList;
}

function pollDevice(deviceId, overwriteDelay) {
    if (!overwriteDelay) {
        overwriteDelay = adapter.config.pollingInterval * 1000;
    }
    if (knownDevices[deviceId].pollingTimeout) {
        clearTimeout(knownDevices[deviceId].pollingTimeout);
        knownDevices[deviceId].pollingTimeout = null;
    }
    knownDevices[deviceId].pollingTimeout = setTimeout(async () => {
        knownDevices[deviceId].pollingTimeout = null;

        const physicalDeviceId = knownDevices[deviceId].data.meshId || deviceId;
        if (knownDevices[physicalDeviceId] && knownDevices[physicalDeviceId].device) {
            if (knownDevices[physicalDeviceId].useRefreshToGet && knownDevices[physicalDeviceId].dpIdList) {
                try {
                    if (!knownDevices[physicalDeviceId].refreshDpList) {
                        knownDevices[physicalDeviceId].refreshDpList = knownDevices[physicalDeviceId].dpIdList.filter(el => knownDevices[physicalDeviceId].device._dpRefreshIds.includes(el));
                    }
                    if (knownDevices[physicalDeviceId].refreshDpList.length) {
                        adapter.log.debug(`${deviceId} request data via refresh for ${JSON.stringify(knownDevices[physicalDeviceId].refreshDpList)}`);
                        knownDevices[physicalDeviceId].waitingForRefrssh = true;
                        const data = await knownDevices[physicalDeviceId].device.refresh({
                            requestedDPS: knownDevices[physicalDeviceId].refreshDpList
                        });
                        // {
                        //                         dps: knownDevices[physicalDeviceId].dpIdList
                        //                     }
                        knownDevices[physicalDeviceId].waitingForRefrssh = false;
                        adapter.log.debug(`${deviceId} response from refresh: ${JSON.stringify(data)}`);
                        knownDevices[physicalDeviceId].device.emit('dp-refresh', {dps: data});
                    }
                    else {
                        adapter.log.debug(`${deviceId} request data via set-refresh for ${JSON.stringify(knownDevices[physicalDeviceId].dpIdList)}`);
                        const setOptions = {
                            dps: knownDevices[physicalDeviceId].dpIdList,
                            set: null
                        };
                        const data = await knownDevices[physicalDeviceId].device.set(setOptions);
                        adapter.log.debug(`${deviceId} response from set-refresh: ${JSON.stringify(data)}`);
                        // adapter.log.debug(deviceId + ' polling not supported');
                    }
                } catch (err) {
                    adapter.log.warn(`${deviceId} error on refresh: ${err.message}`);
                }
            } else {
                try {
                    adapter.log.debug(`${deviceId} request data via get ...`);
                    await knownDevices[physicalDeviceId].device.get({
                        returnAsEvent: true
                    });
                } catch(err) {
                    adapter.log.warn(`${deviceId} error on get: ${err.message}`);
                }
            }
        }
        pollDevice(deviceId);
    }, overwriteDelay);
}

function handleReconnect(deviceId, delay) {
    if (!knownDevices[deviceId]) return;
    delay = delay || 30000;
    if (knownDevices[deviceId].reconnectTimeout) {
        clearTimeout(knownDevices[deviceId].reconnectTimeout);
        knownDevices[deviceId].reconnectTimeout = null;
    }
    knownDevices[deviceId].reconnectTimeout = setTimeout(() => {
        if (!knownDevices[deviceId].device) {
            return;
        }
        knownDevices[deviceId].device.connect().catch(err => {
            adapter.log.warn(`${deviceId}: Error on Reconnect: ${err.message}`);
            handleReconnect(deviceId);
        });
    }, delay);
}

function initDevice(deviceId, productKey, data, preserveFields, callback) {
    if (!preserveFields) {
        preserveFields = [];
    }
    data.productKey = productKey;
    let values;
    if (data.dps) {
        values = data.dps;
        delete data.dps;
    }
    // {"ip":"192.168.178.85","gwId":"34305060807d3a1d7178","active":2,"ability":0,"mode":0,"encrypt":true,"productKey":"8FAPq5h6gdV51Vcr","version":"3.1"}
    if (!data.schema) {
        const known = mapper.getSchema(productKey);
        adapter.log.debug(`${deviceId}: Schema found for ${productKey}: ${JSON.stringify(known)}`);
        if (known) {
            data.schema = known.schema;
            data.schemaExt = known.schemaExt;
        }
    }

    knownDevices[deviceId] = extend(true, {}, knownDevices[deviceId] || {}, {
        'data': data
    });
    knownDevices[deviceId].errorcount = 0;

    if (knownDevices[deviceId].device) {
        knownDevices[deviceId].stop = true;
        if (knownDevices[deviceId].reconnectTimeout) {
            clearTimeout(knownDevices[deviceId].reconnectTimeout);
            knownDevices[deviceId].reconnectTimeout = null;
        }
        if (knownDevices[deviceId].pollingTimeout) {
            clearTimeout(knownDevices[deviceId].pollingTimeout);
            knownDevices[deviceId].pollingTimeout = null;
        }
        if (knownDevices[deviceId].device) {
            knownDevices[deviceId].device.disconnect();
            knownDevices[deviceId].device = null;
        }
    }
    if (!data.localKey) {
        data.localKey = knownDevices[deviceId].localKey || '';
    }
    else {
        knownDevices[deviceId].localKey = data.localKey;
    }
    if (!data.version) {
        data.version = knownDevices[deviceId].version || '';
    }
    else {
        knownDevices[deviceId].version = data.version;
    }
    if (data.ip) {
        knownDevices[deviceId].ip = data.ip;
    }

    adapter.log.debug(`${deviceId}: Create device objects if not exist`);
    objectHelper.setOrUpdateObject(deviceId, {
        type: 'device',
        common: {
            name: data.name || `Device ${deviceId}`
        },
        native: data
    }, preserveFields);
    !data.meshId && objectHelper.setOrUpdateObject(`${deviceId}.online`, {
        type: 'state',
        common: {
            name: 'Device online status',
            type: 'boolean',
            role: 'indicator.reachable',
            read: true,
            write: false
        }
    }, false);
    !data.meshId && objectHelper.setOrUpdateObject(`${deviceId}.ip`, {
        type: 'state',
        common: {
            name: 'Device IP',
            type: 'string',
            role: 'info.ip',
            read: true,
            write: false
        }
    }, data.ip);

    if (data.schema) {
        const objs = mapper.getObjectsForSchema(data.schema, data.schemaExt);
        adapter.log.debug(`${deviceId}: Objects ${JSON.stringify(objs)}`);
        knownDevices[deviceId].dpIdList = initDeviceObjects(deviceId, data, objs, values, preserveFields);
        knownDevices[deviceId].objectsInitialized = true;
    }

    objectHelper.processObjectQueue(() => {
        if (!data.meshId) { // only devices without a meshId are real devices
            if (!knownDevices[deviceId].ip) {
                return checkDiscoveredEncryptedDevices(deviceId, callback);
            }
            adapter.log.info(`${deviceId} Init with IP=${knownDevices[deviceId].ip}, Key=${knownDevices[deviceId].localKey}, Version=${knownDevices[deviceId].version}`);
            knownDevices[deviceId].stop = false;
            knownDevices[deviceId].device = new TuyaDevice({
                id: deviceId,
                key: knownDevices[deviceId].localKey || '0000000000000000',
                ip: knownDevices[deviceId].ip,
                version: knownDevices[deviceId].version,
                nullPayloadOnJSONError: true
            });

            const handleNewData = (data) => {
                knownDevices[deviceId].errorcount = 0;
                if (typeof data !== 'object' || !data || !data.dps) return;
                adapter.log.debug(`${deviceId}: Received data: ${JSON.stringify(data.dps)}`);

                if (knownDevices[deviceId].deepCheckNextData) {
                    const dataKeys = Object.keys(data.dps);
                    const dummyFieldList = ["1", "2", "3", "101", "102", "103"];
                    if (dataKeys.length === dummyFieldList.length && !dataKeys.find(key => !dummyFieldList.includes(key) || data.dps[key] !== null)) {
                        // {"1":null,"2":null,"3":null,"101":null,"102":null,"103":null}
                        adapter.log.debug(`${deviceId}: Ignore invalid data (Counter: ${knownDevices[deviceId].deepCheckNextData})`);
                        knownDevices[deviceId].deepCheckNextData--;
                        return;
                    }
                }

                if (!knownDevices[deviceId].objectsInitialized) {
                    adapter.log.info(`${deviceId}: No schema exists, init basic states ...`);
                    knownDevices[deviceId].dpIdList = initDeviceObjects(deviceId, data, mapper.getObjectsForData(data.dps, !!knownDevices[deviceId].localKey), data.dps, ['name']);
                    knownDevices[deviceId].objectsInitialized = true;
                    objectHelper.processObjectQueue();
                    return;
                }
                for (const id in data.dps) {
                    if (!data.dps.hasOwnProperty(id)) continue;
                    let value = data.dps[id];
                    if (valueHandler[`${deviceId}.${id}`]) {
                        value = valueHandler[`${deviceId}.${id}`](value);
                    }
                    adapter.setState(`${deviceId}.${id}`, value, true);
                }
                pollDevice(deviceId); // lets poll in defined interval
            };

            knownDevices[deviceId].device.on('data', handleNewData);
            knownDevices[deviceId].device.on('dp-refresh', handleNewData);

            knownDevices[deviceId].device.on('connected', () => {
                adapter.log.debug(`${deviceId}: Connected to device`);
                adapter.setState(`${deviceId}.online`, true, true);
                if (knownDevices[deviceId].reconnectTimeout) {
                    clearTimeout(knownDevices[deviceId].reconnectTimeout);
                    knownDevices[deviceId].reconnectTimeout = null;
                }
                knownDevices[deviceId].connected = true;
                connectedCount++;
                if (!connected) setConnected(true);
                pollDevice(deviceId, 1000);
            });

            knownDevices[deviceId].device.on('disconnected', () => {
                adapter.log.debug(`${deviceId}: Disconnected from device`);
                if (knownDevices[deviceId].waitingForRefresh) {
                    knownDevices[deviceId].waitingForRefresh = false;
                    knownDevices[deviceId].useRefreshToGet = false;
                    adapter.log.debug(`${deviceId}: ... seems like Refresh not supported ... disable`);
                    // TODO check once such a case comes up
                }
                adapter.setState(`${deviceId}.online`, false, true);
                if (!knownDevices[deviceId].stop) {
                    if (knownDevices[deviceId].pollingTimeout) {
                        clearTimeout(knownDevices[deviceId].pollingTimeout);
                        knownDevices[deviceId].pollingTimeout = null;
                    }
                    handleReconnect(deviceId);
                }
                if (knownDevices[deviceId].connected) {
                    knownDevices[deviceId].connected = false;
                    connectedCount--;
                }
                if (connected && connectedCount === 0) setConnected(false);
            });

            knownDevices[deviceId].device.on('error', (err) => {
                adapter.log.debug(`${deviceId}: Error from device (${knownDevices[deviceId].errorcount}): App still open on your mobile phone? ${err}`);

                if (err === 'json obj data unvalid') {
                    // Special error case!
                    knownDevices[deviceId].deepCheckNextData = knownDevices[deviceId].deepCheckNextData || 0;
                    knownDevices[deviceId].deepCheckNextData++;
                    if (knownDevices[deviceId].useRefreshToGet === undefined) {
                        knownDevices[deviceId].useRefreshToGet = true;
                        pollDevice(deviceId, 100); // next try with refresh
                    }
                }

                knownDevices[deviceId].errorcount++;

                if (knownDevices[deviceId].errorcount > 3) {
                    knownDevices[deviceId].stop = true;
                    if (knownDevices[deviceId].reconnectTimeout) {
                        clearTimeout(knownDevices[deviceId].reconnectTimeout);
                        knownDevices[deviceId].reconnectTimeout = null;
                    }
                    if (knownDevices[deviceId].pollingTimeout) {
                        clearTimeout(knownDevices[deviceId].pollingTimeout);
                        knownDevices[deviceId].pollingTimeout = null;
                    }
                    if (knownDevices[deviceId].device) {
                        knownDevices[deviceId].device.disconnect();
                        knownDevices[deviceId].device = null;
                    }
                    if (discoveredEncryptedDevices[knownDevices[deviceId].ip]) {
                        discoveredEncryptedDevices[knownDevices[deviceId].ip] = false;
                    }
                }
            });

            knownDevices[deviceId].device.connect().catch(err => {
                adapter.log.error(`${deviceId}: ${err.message}`);
                handleReconnect(deviceId);
            });

            if (!knownDevices[deviceId].localKey) {
                adapter.log.info(`${deviceId}: No local encryption key available, get data using polling, controlling of device NOT possibe. Please sync with App!`);
                pollDevice(deviceId);
            }
        }
        callback && callback();
    });
}


function discoverLocalDevices() {
    server = dgram.createSocket('udp4');
    server.on('listening', function () {
        //const address = server.address();
        adapter.log.info('Listen for local Tuya devices on port 6666');
    });
    const normalParser = new MessageParser({version: 3.1});
    server.on('message', function (message, remote) {
        adapter.log.debug(`Discovered device: ${remote.address}:${remote.port} - ${message}`);
        let data;
        try {
            data = normalParser.parse(message)[0];
        } catch (err) {
            return;
        }
        if (!data.payload || !data.payload.gwId || data.commandByte !== CommandType.UDP) return;
        if (knownDevices[data.payload.gwId] && knownDevices[data.payload.gwId].device && !knownDevices[data.payload.gwId].reconnectTimeout) return;
        initDevice(data.payload.gwId, data.payload.productKey, data.payload, ['name']);
    });
    server.on('error', err => {
        adapter.log.warn(`Can not Listen for Encrypted UDP packages: ${err}`);
    });
    server.bind(6666);

    serverEncrypted = dgram.createSocket('udp4');

    serverEncrypted.on('listening', function () {
        //const address = server.address();
        adapter.log.info('Listen for encrypted local Tuya devices on port 6667');
    });
    serverEncrypted.on('message', function (message, remote) {
        if (!discoveredEncryptedDevices[remote.address]) {
            adapter.log.debug(`Discovered encrypted device and store for later usage: ${remote.address}:${remote.port} - ${message.toString('hex')}`);
            discoveredEncryptedDevices[remote.address] = message;

            // try to auto init devices when known already by using proxy
            if (adapterInitDone) {
                for (let deviceId of Object.keys(knownDevices)) {
                    if (!knownDevices[deviceId].localKey || knownDevices[deviceId].device) continue;
                    checkDiscoveredEncryptedDevices(deviceId);
                }
            }
        }
    });
    serverEncrypted.on('error', err => {
        adapter.log.warn(`Can not Listen for Encrypted UDP packages: ${err}`);
    });
    serverEncrypted.bind(6667);
}

function checkDiscoveredEncryptedDevices(deviceId, callback) {
    const foundIps = Object.keys(discoveredEncryptedDevices);
    adapter.log.debug(`${deviceId}: Try to initialize encrypted device with received UDP messages (#IPs: ${foundIps.length}): version=${knownDevices[deviceId].version}, key=${knownDevices[deviceId].localKey}`);
    const parser = new MessageParser({version: knownDevices[deviceId].version || 3.3, key: knownDevices[deviceId].localKey});
    const parserDefault = new MessageParser({version: knownDevices[deviceId].version || 3.3, key: UDP_KEY});

    for (let ip of foundIps) {
        if (discoveredEncryptedDevices[ip] === true) continue;

        let data;
        // try Default Key
        try {
            data = parserDefault.parse(discoveredEncryptedDevices[ip])[0];
        }
        catch (err) {
            adapter.log.debug(`${deviceId}: Error on default decrypt try: ${err.message}`);
        }
        if (!data || !data.payload || !data.payload.gwId || (data.commandByte !== CommandType.UDP && data.commandByte !== CommandType.UDP_NEW)) {
            adapter.log.debug(`${deviceId}: No relevant Data for default decrypt try: ${JSON.stringify(data)}`);

            // try device key
            try {
                data = parser.parse(discoveredEncryptedDevices[ip])[0];
            }
            catch (err) {
                adapter.log.debug(`${deviceId}: Error on device decrypt try: ${err.message}`);
                continue;
            }
            if (!data || !data.payload || !data.payload.gwId || (data.commandByte !== CommandType.UDP && data.commandByte !== CommandType.UDP_NEW)) {
                adapter.log.debug(`${deviceId}: No relevant Data for device decrypt try: ${JSON.stringify(data)}`);
                continue;
            }
        }
        if (data.payload.gwId === deviceId) {
            discoveredEncryptedDevices[data.payload.ip] = true;
            initDevice(data.payload.gwId, data.payload.productKey, data.payload, ['name'], callback);
            return true;
        }
    }
    adapter.log.info(`${deviceId}: None of the discovered devices matches :-(`);
    callback && callback();
}

function initDone() {
    adapter.log.info('Existing devices initialized');
    discoverLocalDevices();
    adapter.subscribeStates('*');
    discoveredEncryptedDevices = {}; // Clean discovered devices to reset auto detection
    adapterInitDone = true;
}

function processMessage(msg) {
    adapter.log.debug(`Message: ${JSON.stringify(msg)}`);
    switch (msg.command) {
        case 'startProxy':
            startProxy(msg);
            break;
        case 'stopProxy':
            stopProxy(msg);
            break;
        case 'getProxyResult':
            getProxyResult(msg);
            break;
        case 'getDeviceInfo':
            getDeviceInfo(msg);
            break;
    }
}

function startProxy(msg) {
    const ifaces = os.networkInterfaces();
    let ownIp;
    for (const eth in ifaces) {
        if (!ifaces.hasOwnProperty(eth)) continue;
        for (let num = 0; num < ifaces[eth].length; num++) {
            if (ifaces[eth][num].family !== 'IPv6' && ifaces[eth][num].family !== 6 && ifaces[eth][num].address !== '127.0.0.1' && ifaces[eth][num].address !== '0.0.0.0') {
                ownIp = ifaces[eth][num].address;
                adapter.log.debug(`Use first network interface (${ownIp})`);
                break;
            }
        }
        if (ownIp) break;
    }

    if (!proxyServer) {
        msg.message.proxyPort = parseInt(msg.message.proxyPort, 10);
        if (isNaN(msg.message.proxyPort) || msg.message.proxyPort < 1024 || msg.message.proxyPort > 65535) {
            adapter.log.warn('Invalid port set for Proxy. Reset to 8888');
            msg.message.proxyPort = 8888;
        }
        msg.message.proxyWebPort = parseInt(msg.message.proxyWebPort, 10);
        if (isNaN(msg.message.proxyWebPort) || msg.message.proxyWebPort < 1024 || msg.message.proxyWebPort > 65535) {
            adapter.log.warn('Invalid port set for Proxy web port. Reset to 8889');
            msg.message.proxyWebPort = 8889;
        }

        const configPath = path.join(utils.getAbsoluteDefaultDataDir(), adapter.namespace.replace('.', '_'));
        const certPath = path.join(configPath, 'certs/ca.pm');
        const checkerFilePath = path.join(configPath, 'checker');
        if (fs.existsSync(configPath)) {
            try {
                const certStat = fs.statSync(certPath);
                if ((certStat && Date.now() - certStat.ctimeMs > 90 * 24 * 60 * 60 * 1000) || !fs.existsSync(checkerFilePath)) { // > 90d
                    fs.removeSync(configPath);
                    fs.mkdirSync(configPath);
                    fs.writeFileSync(checkerFilePath, '1');
                    adapter.log.info(`Proxy certificates recreated. You need to load the new certificate!`);
                }
            } catch (err) {
                adapter.log.info(`Could not check/recreate proxy certificates: ${err.message}`);
            }
        } else {
            fs.mkdirSync(configPath);
            fs.writeFileSync(checkerFilePath, '1');
        }

        // Create proxy server
        proxyServer = mitm();

        proxyServer.onRequest((ctx, callback) => {
            ctx.onResponse(function(ctx, callback) {
                ctx.proxyToServerRequest.socket.once('close', () => {
                    ctx.clientToProxyRequest.socket.destroy()
                });
                return callback();
            });

            if (ctx.clientToProxyRequest.headers && ctx.clientToProxyRequest.headers.host && ctx.clientToProxyRequest.headers.host.includes('tuya')) {
                const chunks = [];
                ctx.onResponseData(function(ctx, chunk, callback) {
                    chunks.push(chunk);
                    return callback(null, chunk);
                });
                ctx.onResponseEnd(function(ctx, callback) {
                    const body = Buffer.concat(chunks).toString('utf-8');

                    if (body.includes('tuya.m.my.group.device.list')) {
                        let response;
                        try {
                            response = JSON.parse(body);
                        }
                        catch (err) {
                            adapter.log.debug(`SSL-Proxy: error checking response: ${err.message}`);
                            adapter.log.debug(body);
                        }
                        catchProxyInfo(response);
                    }
                    else if (body.startsWith('{') && body.includes('"result":')) {
                        let response;
                        try {
                            response = JSON.parse(body);
                        }
                        catch (err) {
                            response = null;
                        }
                        if (response && response.result && typeof response.result ==='string') {
                            adapter.log.warn('It seems that you use an unsupported App version of Tuya App! Please see Admin Infos and GitHub Readme for details!');
                        }
                    }
                    return callback();
                });
            }

            return callback();
        });

        proxyServer.onError((ctx, err) => {
            adapter.log.error(`SSL-Proxy ERROR: ${err}`);
            adapter.log.error(err.stack);
        });

        proxyServer.listen({
            port: msg.message.proxyPort,
            sslCaDir: configPath,
            keepAlive: true
        }, () => {
            // Create server for downloading certificate
            const serve = serveStatic(path.join(configPath, 'certs'), {});

            // Create server
            staticServer = http.createServer((req, res) => {
                serve(req, res, finalhandler(req, res));
            });

            staticServer.on('error', err => {
                adapter.log.error(`SSL-Proxy could not be started: ${err}`);
                adapter.log.error(err.stack);
            });

            // Listen
            staticServer.listen(msg.message.proxyWebPort, () => {
                adapter.log.info('SSL-Proxy ready to receive requests');
                let QRCode;
                try {
                    QRCode = require('qrcode');
                }
                catch (e) {
                    QRCode = null;
                }
                if (QRCode) {
                    let qrCodeCert;
                    const certUrl = `http://${ownIp}:${msg.message.proxyWebPort}/ca.pem`;
                    QRCode.toDataURL(certUrl).then((url) => {
                        qrCodeCert = url;
                        adapter.sendTo(msg.from, msg.command, {
                            result: {
                                qrcodeCert: qrCodeCert,
                                certUrl
                            },
                            error: null
                        }, msg.callback);
                        proxyStopTimeout = setTimeout(() => {
                            if (proxyServer) {
                                proxyServer.close();
                                staticServer.close();
                                proxyServer = null;
                                staticServer = null;
                            }
                        }, 600000);
                    }).catch(err => {
                        console.error(err.message);
                    });
                }
                else {
                    adapter.sendTo(msg.from, msg.command, {
                        result: {
                            qrcodeCert: 'Not existing'
                        },
                        error: null
                    }, msg.callback);
                    proxyStopTimeout = setTimeout(() => {
                        if (proxyServer) {
                            proxyServer.close();
                            staticServer.close();
                            proxyServer = null;
                            staticServer = null;
                        }
                    }, 600000);
                }
            });
        });

    }
    else {
        clearTimeout(proxyStopTimeout);
        proxyStopTimeout = setTimeout(() => {
            if (proxyServer) {
                proxyServer.close();
                staticServer.close();
                proxyServer = null;
                staticServer = null;
            }
        }, 300000);
        adapter.sendTo(msg.from, msg.command, {
            result:     {
                success: true
            },
            error:      null
        }, msg.callback);
    }
}

function stopProxy(msg) {
    if (proxyServer) {
        try {
            proxyServer.close();
        } catch (e) {
            // ignore
        }
        proxyServer = null;
        try {
            staticServer.close();
        } catch (e) {
            // ignore
        }
        staticServer = null;
    }
    if (msg && adapter) {
        adapter.sendTo(msg.from, msg.command, {
            result: true,
            error: null
        }, msg.callback);
    }
}

function catchProxyInfo(data) {
    if (!data || !data.result || !Array.isArray(data.result)) return;

    let devices = [];
    let deviceInfos = [];

    data.result.forEach((obj) => {
        if (obj.a === 'tuya.m.my.group.device.list') {
            devices = obj.result;
        }
        else if (obj.a === 'tuya.m.device.ref.info.my.list') {
            deviceInfos = obj.result;
        }
    });

    if (deviceInfos && deviceInfos.length) {
        adapter.log.debug(`Found ${deviceInfos.length} device schema information`);
        deviceInfos.forEach((deviceInfo) => {
            if (mapper.addSchema(deviceInfo.id, deviceInfo.schemaInfo)) {
                adapter.log.info(`new Schema added for product type ${deviceInfo.id}. Please send next line from logfile on disk to developer!`);
                adapter.log.info(JSON.stringify(deviceInfo.schemaInfo));
                Sentry && Sentry.withScope(scope => {
                    scope.setLevel('info');
                    scope.setExtra("schema", `"${deviceInfo.id}": ${JSON.stringify(deviceInfo.schemaInfo)}`);
                    Sentry.captureMessage(`Schema ${deviceInfo.id}`, 'info');
                });
            }
        });
    }
    else {
        deviceInfos = [];
    }

    if (devices && devices.length) {
        adapter.log.debug(`Found ${devices.length} devices`);
        devices.forEach((device) => {
            delete device.ip;
            device.schema = false;
            initDevice(device.devId, device.productId, device);
            /*
            {
                "devId": "34305060807d3a1d7832",
                "dpMaxTime": 1540200260064,
                "virtual": false,
                "productId": "8FAPq5h6gdV51Vcr",
                "dps": {
                    "1": false,
                    "2": 0,
                    "3": 1,
                    "4": 0,
                    "5": 0,
                    "6": 2399
                },
                "activeTime": 1539967915,
                "ip": "91.89.163.25",
                "lon": "8.345706",
                "moduleMap": {
                    "wifi": {
                        "upgradeStatus": 0,
                        "bv": "5.27",
                        "cdv": "1.0.0",
                        "pv": "2.1",
                        "verSw": "1.0.1",
                        "isOnline": true,
                        "id": 2952706,
                        "cadv": ""
                    },
                    "mcu": {
                        "upgradeStatus": 0,
                        "cdv": "",
                        "verSw": "1.0.1",
                        "isOnline": true,
                        "id": 2952707,
                        "cadv": ""
                    }
                },
                "uuid": "34305060807d3a1d7832",
                "name": "Steckdose 1",
                "timezoneId": "Europe/Berlin",
                "iconUrl": "https://images.tuyaus.com/smart/icon/1521522457nf46uh6z3tk3jag1m6bfq1tt9_0.jpg",
                "lat": "49.035754",
                "runtimeEnv": "prod",
                "localKey": "03c5e7d3b8c97ec0"
            }
            */
        });
    }
    else {
        devices = [];
    }
    if (proxyAdminMessageCallback) {
        console.log('send ... ... ... ...');
        adapter.sendTo(proxyAdminMessageCallback.from, proxyAdminMessageCallback.command, {
            result:     {
                schemaCount: deviceInfos.length,
                deviceCount: devices.length
            },
            error:      null
        }, proxyAdminMessageCallback.callback);
        proxyAdminMessageCallback = null;
    }
}

function getProxyResult(msg) {
    proxyAdminMessageCallback = msg;

    // To simulate a successfull response ...
    /*
    if (proxyAdminMessageCallback) {
        console.log('send ... ... ... ...');
        adapter.sendTo(proxyAdminMessageCallback.from, proxyAdminMessageCallback.command, {
            result:     {
                schemaCount: 1,
                deviceCount: 2
            },
            error:      null
        }, proxyAdminMessageCallback.callback);
        proxyAdminMessageCallback = null;
    }
    */
}

function getDeviceInfo(msg) {
    let devices = 0;
    let devicesConnected = 0;
    let devicesWithSchema = 0;
    let devicesWithLocalKey = 0;

    for (const deviceId in knownDevices) {
        if (!knownDevices.hasOwnProperty(deviceId)) continue;

        devices++;
        if (knownDevices[deviceId].device) devicesConnected++;
        if (knownDevices[deviceId].localKey) devicesWithLocalKey++;
        if (knownDevices[deviceId].data.schema) devicesWithSchema++;
    }
    adapter.sendTo(msg.from, msg.command, {
        result:     {
            devices: devices,
            devicesConnected: devicesConnected,
            devicesWithLocalKey: devicesWithLocalKey,
            devicesWithSchema: devicesWithSchema
        },
        error:      null
    }, msg.callback);

}

async function cloudLogin() {
  const Cloud = require('./lib/tuyaapi_cloud');
  const apiKeys = {
    key: '3fjrekuxank9eaej3gcx',
    certSign: '93:21:9F:C2:73:E2:20:0F:4A:DE:E5:F7:19:1D:C6:56:BA:2A:2D:7B:2F:F5:D2:4C:D5:5C:4B:61:55:00:1E:40',
    secret2: 'vay9g59g9g99qf3rtqptmc3emhkanwkx',
    secret: 'aq7xvqcyqcnegvew793pqjmhv77rneqc',
  };
  try {
    adapter.api = new Cloud({
      key: apiKeys.key,
      secret: apiKeys.secret,
      secret2: apiKeys.secret2,
      certSign: apiKeys.certSign,
      apiEtVersion: '0.0.1',
      region: '49',
      adapter: adapter,
    });
  } catch (e) {
    adapter.log.error('Error creating cloud API: ' + e);
    return;
  }

  await adapter.api
    .loginEx({ email: adapter.config.cloudUsername, password: adapter.config.cloudPassword })
    .then(async (sid) => {
      adapter.log.debug(`Cloud sid:  ${sid} `);
      return sid;
    })
    .catch((err) => {
      adapter.log.error(`Cloud login failed: ${err}`);
      return null;
    });
}
async function receiveCloudDevices() {
  await adapter.api.request({ action: 'tuya.m.location.list' }).then(async (groups) => {
    let deviceList = [];
    let deviceListInfo = [];
    for (const group of groups) {
      const resultDevices = await adapter.api
        .request({ action: 'tuya.m.my.group.device.list', gid: group.groupId })
        .catch((err) => {
          adapter.log.error(`Error: ${err}`);
        });
      deviceList = [...deviceList, ...resultDevices];
      const resultInfo = await adapter.api
        .request({ action: 'tuya.m.device.ref.info.my.list', gid: group.groupId, v: '2.0' })
        .catch((err) => {
          adapter.log.error(`Error: ${err}`);
        });
      deviceListInfo = [...deviceListInfo, ...resultInfo];
    }
    catchProxyInfo({
      result: [
        {
          a: 'tuya.m.my.group.device.list',
          success: true,
          v: '1.0',
          status: 'ok',
          result: deviceList,
        },
        {
          a: 'tuya.m.device.ref.info.my.list',
          success: true,
          v: '2.0',
          status: 'ok',
          result: deviceListInfo,
        },
      ],
    });
  });
}
async function main() {
    setConnected(false);
    objectHelper.init(adapter);
    if (adapter.config.cloudUsername && adapter.config.cloudPassword) {
        adapter.log.info("Try to login with cloud credentials");
        await cloudLogin();
        await receiveCloudDevices();
      }
    try {
        const mitmCaFile = require.resolve('http-mitm-proxy/lib/ca.js');
        if (mitmCaFile) {
            let fileContent = fs.readFileSync(mitmCaFile, 'utf-8');
            if (fileContent && fileContent.includes('.validity.notBefore.getFullYear() + 2);')) {
                // hacky workaround ... replace twice because should be included two times
                fileContent = fileContent.replace('.validity.notBefore.getFullYear() + 2);', '.validity.notBefore.getFullYear() + 1);');
                fileContent = fileContent.replace('.validity.notBefore.getFullYear() + 2);', '.validity.notBefore.getFullYear() + 1);');
                fs.writeFileSync(mitmCaFile, fileContent, 'utf-8');
                adapter.log.info('http-mitm-proxy/lib/ca.js patched to only generate 1 year long certificates');
            } else {
                adapter.log.debug('http-mitm-proxy/lib/ca.js already patched to only generate 1 year long certificates');
            }
        } else {
            adapter.log.info('http-mitm-proxy/lib/ca.js not found');
        }
    } catch (e) {
        adapter.log.warn(`Cannot patch http-mitm-proxy/lib/ca.js: ${e}`);
    }
    mitm = require('http-mitm-proxy');

  

    adapter.config.pollingInterval = parseInt(adapter.config.pollingInterval, 10) || 60;
    if (adapter.config.pollingInterval < 10) {
        adapter.log.info(`Polling interval ${adapter.config.pollingInterval} too short, setting to 30s`);
        adapter.config.pollingInterval = 30;
    }

    adapter.getDevices((err, devices) => {
        let deviceCnt = 0;
        if (devices && devices.length) {
            adapter.log.debug(`init ${devices.length} known devices`);
            devices.forEach((device) => {
                if (device._id && device.native) {
                    const id = device._id.substr(adapter.namespace.length + 1);
                    deviceCnt++;
                    initDevice(id, device.native.productKey, device.native, ['name'], () => {
                        if (!--deviceCnt) initDone();
                    });
                }
            });
        }
        if (!deviceCnt) {
            initDone();
        }
    });
}

// If started as allInOne/compact mode => return function to create instance
if (module && module.parent) {
    module.exports = startAdapter;
} else {
    // or start the instance directly
    startAdapter();
}
