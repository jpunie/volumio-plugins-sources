'use strict';

var libQ = require('kew');
var fs = require('fs-extra');
var config = new (require('v-conf'))();
var exec = require('child_process').exec;
var execSync = require('child_process').execSync;
var io = require('socket.io-client');
var net = require('net');


module.exports = denonControl;
function denonControl(context) {
    var self = this;

    this.context = context;
    this.commandRouter = this.context.coreCommand;
    this.logger = this.context.logger;
    this.configManager = this.context.configManager;

    this.connectionOptions = {
        port: 23,
        host: ''
    };
    this.musicState = 'stopped';
    this.receiverState = 'off';
    this.volume = 0;
    this.client = null;
    this.isConnected = false;
}

denonControl.prototype.onVolumioStart = function () {
    var self = this;
    var configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
    this.config = new (require('v-conf'))();
    self.logger.debug("DENON-CONTROL: CONFIG FILE: " + configFile);
    this.config.loadFile(configFile);

    this.load18nStrings();

    return libQ.resolve();
}

denonControl.prototype.onStart = function () {
    var self = this;
    var defer = libQ.defer();

    self.running = true;
    self.socket = io.connect('http://localhost:3000');

    self.connectionOptions.host = self.config.get('receiverIP');
    self.connectionOptions.port = parseInt(self.config.get('receiverPort', 23));

    if (self.connectionOptions.host) {
        self.connect();
    } else {
        self.commandRouter.pushToastMessage("info", "No Denon receiver configured. Please manually configure.");
    }

    self.logger.info("DENON-CONTROL: *********** DENON PLUGIN STARTED ********");
    defer.resolve();

    self.socket.on('pushState', function (state) {
        self.handleStateChange(state);
    });

    return defer.promise;
};

denonControl.prototype.onStop = function () {
    var self = this;
    var defer = libQ.defer();

    self.running = false;
    self.logger.info("DENON-CONTROL: *********** DENON PLUGIN STOPPED ********");

    if (self.client) {
        self.client.destroy();
        self.client = null;
        self.isConnected = false;
    }
    self.socket.disconnect();

    defer.resolve();

    return libQ.resolve();
};

denonControl.prototype.onRestart = function () {
    var self = this;
    // Optional, use if you need it
};

denonControl.prototype.connect = function () {
    const self = this;

    if (self.client) {
        return;
    }

    if (!self.connectionOptions.host) {
        return;
    }

    self.logger.info(`DENON-CONTROL: Connecting to ${self.connectionOptions.host}:${self.connectionOptions.port}`);

    self.client = new net.Socket();

    self.client.connect(self.connectionOptions.port, self.connectionOptions.host, function () {
        self.logger.info('DENON-CONTROL: Connected to receiver');
        self.isConnected = true;
        // Request volume on connection
        self.client.write('MV?\r');
    });

    self.client.on('data', function (data) {
        const dataStr = data.toString().trim();
        self.logger.info('DENON-CONTROL: Received data: ' + dataStr);
        if (dataStr.startsWith('MV') && !dataStr.startsWith('MVMAX')) {
            let volStr = dataStr.substring(2, 4);
            self.logger.debug('DENON-CONTROL: volume data: ' + volStr);
            var vol = parseInt(volStr);  
            const maxVolume = self.config.get('maxVolume', 66);
            if (!isNaN(vol) && vol >= 0 && vol <= maxVolume) {
                self.logger.info('DENON-CONTROL: Received volume update: ' + vol);
                self.volume = vol;
                self.commandRouter.volumiosetvolume(vol);
            } else {
                self.logger.error('DENON-CONTROL: Received invalid volume data: ' + volStr);
            }
        }
    });

    self.client.on('close', function () {
        self.logger.info('DENON-CONTROL: Connection closed');
        self.isConnected = false;
        if (self.client) {
            self.client.destroy();
        }
        self.client = null;

        if (self.running) {
            self.logger.info('DENON-CONTROL: Reconnecting in 10s...');
            setTimeout(() => {
                if (self.running) {
                    self.connect();
                }
            }, 10000);
        }
    });

    self.client.on('error', function (err) {
        self.logger.error('DENON-CONTROL: Connection error: ' + err.message);
        self.isConnected = false;
        if (self.client) {
            self.client.destroy();
        }
    });
};

denonControl.prototype.sendCommand = function (command) {
    const self = this;

    if (!self.isConnected || !self.client) {
        self.logger.warn('DENON-CONTROL: Not connected, trying to connect...');
        self.connect();
        // Simple retry logic could be added here, but for now just try to connect for next time
        return;
    }

    self.logger.debug(`DENON-CONTROL: Sending command: ${command}`);
    self.client.write(command + '\r');
};

denonControl.prototype.handleStateChange = function (state) {
    const self = this;

    self.logger.debug("DENON-CONTROL: State change: " + state.status);

    if (state.status !== self.musicState) {
        self.musicState = state.status;

        switch (self.musicState) {
            case 'play':
                if (self.receiverState === 'off') {
                    if (self.config.get('powerOn')) {
                        self.sendCommand('ZMON');
                    }

                    if (self.config.get('setVolume')) {
                        let volume = self.config.get('setVolumeValue', 20);
                        const maxVolume = self.config.get('maxVolume', 66);
                        
                        if (volume > maxVolume) {
                            volume = maxVolume;
                        }

                        self.volume = volume;
                        // Sync Volumio volume
                        self.socket.emit("volume", self.volume);

                        // Denon volume is 0-66. 
                        let denonVol = Math.min(self.volume, maxVolume);
                        self.sendCommand('MV' + denonVol);
                    }

                    if (self.config.get('setInput')) {
                        const input = self.config.get('setInputValue', 'CD');
                        self.sendCommand('SI' + input);
                    }

                    self.receiverState = 'on';
                }
                break;

            case 'stop':
            case 'pause':
                if (self.config.get('standby', true)) {
                    if (self.receiverState === 'on') {
                        setTimeout(() => {
                            if (self.musicState !== 'play' && self.receiverState === 'on') {
                                self.receiverState = 'off';
                                self.sendCommand('ZMOFF');
                            }
                        }, self.config.get('standbyDelay') * 1000);
                    }
                }
                break;
        }
    } else {
        // Volume change handling
        if (self.receiverState === 'on' && self.volume !== state.volume) {
            const maxVolume = self.config.get('maxVolume', 66);
            self.volume = (state.volume) > maxVolume ? maxVolume : state.volume;

            let denonVol = Math.min(self.volume, maxVolume);
            self.sendCommand('MV' + denonVol);
        }
    }
};

denonControl.prototype.refreshUIConfig = function () {
    let self = this;
    self.commandRouter.getUIConfigOnPlugin('system_hardware', 'denon_control', {}).then(config => {
        self.commandRouter.broadcastMessage('pushUiConfig', config);
    });
}

// Configuration Methods -----------------------------------------------------------------------------

denonControl.prototype.getUIConfig = function () {
    var defer = libQ.defer();
    var self = this;

    var lang_code = this.commandRouter.sharedVars.get('language_code');

    self.commandRouter.i18nJson(__dirname + '/i18n/strings_' + lang_code + '.json',
        __dirname + '/i18n/strings_en.json',
        __dirname + '/UIConfig.json')
        .then(function (uiconf) {
            // Connection Section
            uiconf.sections[0].content[0].value = self.config.get('receiverIP');
            uiconf.sections[0].content[1].value = self.config.get('receiverPort', 23);

            // Actions Section
            uiconf.sections[1].content[0].value = self.config.get('powerOn');
            uiconf.sections[1].content[1].value = self.config.get('maxVolume');
            uiconf.sections[1].content[2].value = self.config.get('setVolume');
            uiconf.sections[1].content[3].value = self.config.get('setVolumeValue');
            uiconf.sections[1].content[4].value = self.config.get('setInput');
            uiconf.sections[1].content[5].value = self.config.get('setInputValue');
            uiconf.sections[1].content[6].value = self.config.get('standby');
            uiconf.sections[1].content[7].value = self.config.get('standbyDelay');

            defer.resolve(uiconf);
        })
        .fail(function () {
            defer.reject(new Error());
        });

    return defer.promise;
};
denonControl.prototype.saveConnectionConfig = function (data) {
    var self = this;

    self.config.set('receiverIP', data['receiverIP']);
    self.config.set('receiverPort', data['receiverPort']);

    self.connectionOptions.host = data['receiverIP'];
    self.connectionOptions.port = parseInt(data['receiverPort']);

    // Reconnect with new settings
    if (self.client) {
        self.client.destroy();
        self.client = null;
        self.isConnected = false;
    }
    self.connect();

    self.commandRouter.pushToastMessage('success', self.getI18nString("SETTINGS_SAVED"), self.getI18nString("SETTINGS_SAVED_CONNECTION"));
    self.refreshUIConfig();

    return 1;
};

denonControl.prototype.saveActionConfig = function (data) {
    var self = this;

    self.config.set('powerOn', data['powerOn']);
    self.config.set('maxVolume', parseInt(data['maxVolume']));
    self.config.set('setVolume', data['setVolume']);
    self.config.set('setVolumeValue', parseInt(data['setVolumeValue']));
    self.config.set('setInput', data['setInput']);
    self.config.set('setInputValue', data['setInputValue']);
    self.config.set('standby', data['standby']);
    self.config.set('standbyDelay', parseInt(data['standbyDelay']));

    self.commandRouter.pushToastMessage('success', self.getI18nString("SETTINGS_SAVED"), self.getI18nString("SETTINGS_SAVED_ACTION"));

    return 1;
};

denonControl.prototype.load18nStrings = function () {
    var self = this;

    try {
        var language_code = this.commandRouter.sharedVars.get('language_code');
        self.i18nStrings = fs.readJsonSync(__dirname + '/i18n/strings_' + language_code + ".json");
    }
    catch (e) {
        self.i18nStrings = fs.readJsonSync(__dirname + '/i18n/strings_en.json');
    }

    self.i18nStringsDefaults = fs.readJsonSync(__dirname + '/i18n/strings_en.json');
};

denonControl.prototype.getI18nString = function (key) {
    var self = this;

    if (self.i18nStrings[key] !== undefined) {
        return self.i18nStrings[key];
    }
    else {
        return self.i18nStringsDefaults[key];
    }
};

denonControl.prototype.getConfigurationFiles = function () {
    return ['config.json'];
}

denonControl.prototype.setUIConfig = function (data) {
    var self = this;
    //Perform your installation tasks here
};

denonControl.prototype.getConf = function (varName) {
    var self = this;
    //Perform your installation tasks here
};

denonControl.prototype.setConf = function (varName, varValue) {
    var self = this;
    //Perform your installation tasks here
};



// Playback Controls ---------------------------------------------------------------------------------------
// If your plugin is not a music_sevice don't use this part and delete it


denonControl.prototype.addToBrowseSources = function () {

    // Use this function to add your music service plugin to music sources
    //var data = {name: 'Spotify', uri: 'spotify',plugin_type:'music_service',plugin_name:'spop'};
    this.commandRouter.volumioAddToBrowseSources(data);
};

denonControl.prototype.handleBrowseUri = function (curUri) {
    var self = this;

    //self.commandRouter.logger.info(curUri);
    var response;


    return response;
};



// Define a method to clear, add, and play an array of tracks
denonControl.prototype.clearAddPlayTrack = function (track) {
    var self = this;
    self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'denonControl::clearAddPlayTrack');

    self.commandRouter.logger.info(JSON.stringify(track));

    return self.sendSpopCommand('uplay', [track.uri]);
};

denonControl.prototype.seek = function (timepos) {
    this.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'denonControl::seek to ' + timepos);

    return this.sendSpopCommand('seek ' + timepos, []);
};

// Stop
denonControl.prototype.stop = function () {
    var self = this;
    self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'denonControl::stop');


};

// Spop pause
denonControl.prototype.pause = function () {
    var self = this;
    self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'denonControl::pause');


};

// Get state
denonControl.prototype.getState = function () {
    var self = this;
    self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'denonControl::getState');


};

//Parse state
denonControl.prototype.parseState = function (sState) {
    var self = this;
    self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'denonControl::parseState');

    //Use this method to parse the state and eventually send it with the following function
};

// // Announce updated State
// denonControl.prototype.pushState = function(state) {
// 	var self = this;
// 	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'denonControl::pushState');

// 	return self.commandRouter.servicePushState(state, self.servicename);
// };


denonControl.prototype.explodeUri = function (uri) {
    var self = this;
    var defer = libQ.defer();

    // Mandatory: retrieve all info for a given URI

    return defer.promise;
};

denonControl.prototype.getAlbumArt = function (data, path) {

    var artist, album;

    if (data != undefined && data.path != undefined) {
        path = data.path;
    }

    var web;

    if (data != undefined && data.artist != undefined) {
        artist = data.artist;
        if (data.album != undefined)
            album = data.album;
        else album = data.artist;

        web = '?web=' + nodetools.urlEncode(artist) + '/' + nodetools.urlEncode(album) + '/large'
    }

    var url = '/albumart';

    if (web != undefined)
        url = url + web;

    if (web != undefined && path != undefined)
        url = url + '&';
    else if (path != undefined)
        url = url + '?';

    if (path != undefined)
        url = url + 'path=' + nodetools.urlEncode(path);

    return url;
};





denonControl.prototype.search = function (query) {
    var self = this;
    var defer = libQ.defer();

    // Mandatory, search. You can divide the search in sections using following functions

    return defer.promise;
};

denonControl.prototype._searchArtists = function (results) {

};

denonControl.prototype._searchAlbums = function (results) {

};

denonControl.prototype._searchPlaylists = function (results) {


};

denonControl.prototype._searchTracks = function (results) {

};

denonControl.prototype.goto = function (data) {
    var self = this
    var defer = libQ.defer()

    // Handle go to artist and go to album function

    return defer.promise;
};
