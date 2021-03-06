var mosca = require('mosca');
var fs = require('fs');
const http = require('http');
const args = require('minimist')(process.argv.slice(2));

const content = fs.readFileSync(args.c, 'utf8');
const config = JSON.parse(content)

const serverHost       = config.server.host;           
const internalPort     = config.server.internal.port;
const internalUsername = config.worker.username;
const internalPassword = config.worker.password;
const agentHost        = config.agent.host;
const agentPort        = config.agent.ports.http;
const externalPort     = config.server.external.port;
const externalCertPath = config.server.external.certPath;
const externalCertKey  = config.server.external.keyPath;

var conn = 0;
var maxConn = -1;

var settings = {
    interfaces: [
        { type: "mqtt", port: internalPort },
        { type: "mqtts", port: externalPort},
    ],
    secure : {
        certPath: externalCertPath,
        keyPath: externalCertKey,
    },
    logger: {
        level: config.server.logger.level,
        stream: fs.createWriteStream(config.server.logger.path, {'flags': 'a'}),
    }
};

var logger = require("pino")(settings.logger, settings.logger.stream);
var server = new mosca.Server(settings);

server.on('clientConnected', function(client) {
    logger.info('Client connected', client.id);
    conn++;
});

server.on('clientDisconnected', function(client) {
    logger.info('Client disconnected', client.id);
    conn--;
});

server.on('published', function(packet, client) {
    logger.info('Published', packet.topic, packet.payload.toString());
});

server.on('ready', setup);

var updateBroker = function() {
    const params = {
        external: serverHost + ":" + externalPort,
        internal: serverHost + ":" + internalPort,
        conn: conn >= 0 ? conn : 0,
        maxConn: maxConn,
    }
    const requestBody = JSON.stringify(params);
    const options = {
        host: agentHost,
        port: agentPort,
        path: '/v1/broker/update',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': requestBody.length
        }
    };
    var req = http.request(options, (res) => {
        var responseString = '';
        res.on('data', function (data) {
            responseString += data;
        });
        res.on('end', function () {
            logger.info("updateBroker", responseString);
        });
    });
    req.on('error', function(e) {
        logger.error(e);
    });
    req.write(requestBody);
    req.end();
}

var authenticateUser = function(username, password, callback) {
    const params = {
        username: username,
    }
    const requestBody = JSON.stringify(params);
    const options = {
        host: agentHost,
        port: agentPort,
        path: '/v1/user/get',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': requestBody.length
        }
    };
    var req = http.request(options, (res) => {
        var responseString = '';
        res.on('data', function (data) {
            responseString += data;
        });
        res.on('end', function () {
            logger.info("authenticateUser", responseString);
            try {
                var obj = JSON.parse(responseString)
                if (obj.username == username && obj.password == password) {
                    callback(null, true)
                    return
                }
            } catch(e) {
                logger.error(e)
            }
            callback(null, false)
        });
        res.on('error', function() {
            logger.error(e)
            callback(null, false)
        });
    });
    req.on('error', function(e) {
        logger.error(e)
        callback(null, false)
    });
    req.write(requestBody);
    req.end();
}

var isUserInGroup = function(uid, gid, callback) {
    const params = {
        group_id: gid,
        member_id: uid,
    }
    const requestBody = JSON.stringify(params);
    const options = {
        host: agentHost,
        port: agentPort,
        path: '/v1/group/is/member',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': requestBody.length
        }
    };
    var req = http.request(options, (res) => {
        var responseString = '';
        res.on('data', function (data) {
            responseString += data;
        });
        res.on('end', function () {
            logger.info("isUserInGroup", responseString);
            try {
                var obj = JSON.parse(responseString)
                if (obj.ok + "" === "true") {
                    callback(null, true)
                    return
                }
            } catch(e) {
                logger.error(e)
            }
            callback(null, false)
        });
        res.on('error', function(e) {
            logger.error(e)
            callback(null, false)
        });
    });
    req.on('error', function(e) {
        logger.error(e)
        callback(null, false)
    });
    req.write(requestBody);
    req.end();
}

var userIdByClient = function(client) {
    return client.id
}

var authenticate = function(client, username, password, callback) {
    logger.info("Authenticate", client.id, username, password.toString());
    if (username === internalUsername) {
        if (internalPassword !== "" && password.toString() == internalPassword) {
            client.username = internalUsername;
            callback(null, true);
        } else {
            callback(null, false);
        }
    } else {
        authenticateUser(username, password.toString(), callback);
    }
}

var authorizePublish = function(client, topic, payload, callback) {
    logger.info("Publish", client.id, topic, payload.toString());
    if (client.username === internalUsername) {
        callback(null, true);
    } else {
        callback(null, false);
    }
}

var authorizeSubscribe = function(client, topic, callback) {
    logger.info("Subscribe", client.id, topic);
    const ts = topic.split('/');
    if (ts.length < 2) {
        callback(null, false);
        return;
    }

    switch(ts[0]) {
        case "u":
            var uid = userIdByClient(client);
            if (uid != "" && uid == ts[1]) {
                callback(null, true);
                return;
            }
        break;
        case "p":
            callback(null, true);
            return;
        case "g":
            var uid = userIdByClient(client);
            isUserInGroup(uid, ts[1], callback);
            return
    }

    callback(null, false);
}

function setup() {
    logger.info('Mosca server is up and running');
    server.authenticate = authenticate;
    server.authorizePublish = authorizePublish;
    server.authorizeSubscribe = authorizeSubscribe;

    updateBroker();
    setInterval(function(){
        updateBroker();
    }, 5000)
}