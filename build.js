var http = require('http');
var path = require('path');
var fs = require('fs');
var _url = require('url');
var Minio = require('minio');
var Logger = require('raft-logger-redis').Logger;
var uuid = require('node-uuid');
var async = require('async');

var nconf = require('nconf');
var colors = require('colors');

nconf.file({
	file : path.resolve(process.argv[2])
});
nconf.env();

var mongoose = require('nodetopia-model');

var errors = require('nodetopia-lib/errors');
var helpers = require('nodetopia-lib/helpers');

/*
 *Setup mongodb store
 */
mongoose.start(nconf.get('mongodb'));
/*
 *Setup Kue jobs
 */
var kue = require('nodetopia-kue');
var jobs = kue.jobs;
/*
 *
 */
var minioClient = new Minio(nconf.get('s3'));
/*
 *
 */
var logs = Logger.createLogger(nconf.get('logs'));

function buildFormatiion(docs, env, size, zones) {
	return {
		reference : docs.app._id,
		type : 'build',
		container : {
			logs : nconf.get('logs'),
			logSession : docs.app.logSession,
			metricSession : docs.app.metricSession,
			source : 'build',
			user : 'root',
			process : 'build',
			channel : 'build.0',
			name : docs.app.organization.name + '.' + docs.app.name + '.build',
			index : 0,
			restartable : false,
			env : env,
			uid : uuid.v4(),
			username : docs.app.organization.name,
			shortLived : true,
			size : size,
			zones : zones,
			image : nconf.get('builder:buildpack:build') || 'nodetopia/cedar:builder',
			ports : []
		}
	};
}

function setEnv(docs, cb) {

	var buildPath = docs.app.organization.name + '/' + docs.app.name + '/build/' + docs.tag + '.tar';
	var cachePath = docs.app.organization.name + '/' + docs.app.name + '/cache.tar';
	var env = {
		USER : 'herokuishuser',
		APP_UPLOAD_PATH : 'tar/' + buildPath,
		CACHE_UPLOAD_PATH : 'tar/' + cachePath
	};

	minioClient.presignedGetObject('tar', docs.commit.tar, 24 * 60 * 60, function(err, appUrl) {
		if (err) {
			return cb(err)
		}
		env.APP_URL = appUrl;
		minioClient.presignedGetObject('tar', cachePath, 24 * 60 * 60, function(err, cacheUrl) {
			if (err) {
				return cb(err)
			}
			env.CACHE_URL = cacheUrl;
			cb(null, env);
		});
	});
}

function getView(job, docs) {
	var view = require('raft-logger-redis').View.createView({
		host : nconf.get('logs:web:host'),
		port : nconf.get('logs:web:port'),
		session : docs.app.logSession,
		backlog : false,
		ws : true
	});
	view.filter({
		source : 'build',
		channel : 'build.0'
	}).on('json', function(line) {
		line = line.msg.split('[1G').pop();
		if (line == '       ') {
			return
		}
		job.log(line);
	});
	view.start();
	return view;
}

function getTarStats(docs, cb) {

	async.parallel({
		build : function(callback) {
			var buildPath = docs.app.organization.name + '/' + docs.app.name + '/build/' + docs.tag + '.tar';
			minioClient.statObject('tar', buildPath, function(err, stats) {
				if (err) {
					return callback(err)
				}
				stats.app = docs.app._id;
				stats.path = buildPath;
				mongoose.BuildTar.findOne({
					etag : stats.etag,
					app : docs.app._id
				}, function(err, tar) {
					if (err) {
						return callback(err)
					}
					if (tar) {
						return callback(null, tar)
					}

					tar = new mongoose.BuildTar(stats);
					tar.save(function(err) {
						if (err) {
							return callback(err)
						}
						callback(null, tar);

					});
				});

			});
		},
		application : function(callback) {
			minioClient.statObject('tar', docs.commit.tar, function(err, stats) {
				if (err) {
					return callback(err)
				}
				stats.app = docs.app._id;
				stats.path = docs.commit.tar;
				mongoose.BuildTar.findOne({
					etag : stats.etag,
					app : docs.app._id
				}, function(err, tar) {
					if (err) {
						return callback(err)
					}
					if (tar) {
						return callback(null, tar)
					}

					tar = new mongoose.BuildTar(stats);
					tar.save(function(err) {
						if (err) {
							return callback(err)
						}
						callback(null, tar);

					});
				});
			});
		},
		cache : function(callback) {
			var cachePath = docs.app.organization.name + '/' + docs.app.name + '/cache.tar';
			minioClient.statObject('tar', cachePath, function(err, stats) {
				if (err) {
					return callback(err)
				}
				stats.app = docs.app._id;
				stats.path = cachePath;
				mongoose.BuildTar.findOne({
					etag : stats.etag,
					app : docs.app._id
				}, function(err, tar) {
					if (err) {
						return callback(err)
					}
					if (tar) {
						return callback(null, tar)
					}

					tar = new mongoose.BuildTar(stats);
					tar.save(function(err) {
						if (err) {
							return callback(err)
						}
						callback(null, tar);

					});
				});
			});
		}
	}, cb);
}

function saveBuild(job, docs, container, cb) {

	getTarStats(docs, function(err, results) {

		var build = new mongoose.Build({
			organization : docs.app.organization._id,
			app : docs.app._id,
			process : job.id,
			commit : docs.commit._id,
			container : container._id,
			name : docs.app.name,
			build : results.build,
			application : results.application,
			cache : results.cache,
			version : docs.tag,
			procfile : Object.keys(job.data.proc).map(function(process) {
				job.data.proc[process].process = process;
				return job.data.proc[process];
			}),
			is_active : container.statusCode == 0,
			failed : container.statusCode !== 0
		});

		function save() {
			docs.build = build;
			build.save(function(err) {
				if (err) {
					console.log(err)
					kue.events.emit('builder.error', err);
					return cb(err);
				}
				cb(null, build);
			});
		}

		if (build.failed) {
			save();
		} else {
			mongoose.Build.update({
				app : docs.app._id
			}, {
				is_active : false
			}, {
				multi : true
			}, function(err) {
				if (err) {
					kue.events.emit('builder.error', err);
					return cb(err);
				}
				save();
			});
		}

	});
}

function buildSuccess(job, docs, container, done) {

}

function setFormation(job, docs, cb) {

	var oldCmds = docs.formation.commands;
	docs.formation.commands = [];

	var types = {};
	var processes = 0;
	docs.build.procfile.forEach(function(item) {

		if (item.process == 'build' || item.process == 'addon') {
			return job.log('----->' + (' Process type ' + item.process + ' is system reserved name').red);
		}

		var cmd = oldCmds.filter(function(cmd) {
		return cmd.type == item.process;
		})[0];

		if (cmd) {
			if (item.process == 'web' && cmd.quantity == 0) {
				cmd.quantity = 1;
			}

			processes += cmd.quantity;
			docs.formation.commands.push(cmd);
		} else {
			docs.formation.commands.push({
				type : item.process,
				quantity : 1,
				size : docs.app.organization.quota.plan.size
			});
			processes += 1;
		}
	});

	if (processes > docs.app.organization.quota.plan.processes) {
		job.log('----->' + ' Process limit has been hit'.red);
		for (var i = docs.formation.commands.length - 1; i >= 0; i--) {

			var cmd = docs.formation.commands[i];

			if (processes - cmd.quantity > docs.app.organization.quota.plan.processes && i != 0) {

				processes = processes - cmd.quantity;
				cmd.quantity = 0;

				job.log('----->' + (cmd.type + ' has been scaling to 0').red);
			} else if (i == 0) {
				cmd.quantity = docs.app.organization.quota.plan.processes;
				job.log('----->' + (cmd.type + ' has been scaling to ' + cmd.quantity).red);

			} else {
				cmd.quantity = docs.app.organization.quota.plan.processes - docs.app.organization.quota.plan.processes;
				job.log('----->' + (cmd.type + ' has been scaling to ' + cmd.quantity).red);
				break;
			}
		};
	}
	docs.formation.save(cb);

}

function build(job, docs, done) {
	var view = getView(job, docs);
	mongoose.Size.findOne({
		type : 'build'
	}, function(err, size) {
		setEnv(docs, function(err, env) {
			var formation = buildFormatiion(docs, env, size, [{
				name : 'par1'
			}]);
			function onComplete(container) {

				kue.events.removeListener('build.complete.' + formation.container.uid, onComplete);

				view.end();
				saveBuild(job, docs, container, function(err, build) {
					if (err) {
						return done(err);
					}

					if (build.failed) {
						return done(new Error('Build failed please look at the logs'));
					}
					setFormation(job, docs, function(err) {
						if (err) {
							return done(err)
						}

						done(null, build);
					});
				});
			}


			kue.events.on('build.complete.' + formation.container.uid, onComplete);
			kue.fleet.container.start(formation, function(err, container) {
				if (err) {
					kue.events.removeListener('build.complete.' + formation.container.uid, onComplete);
					view.end();
					return done(err)
				}

			});

		});
	});
}

jobs.process('build', 20, function(job, done) {
	//console.log(job.data)
	kue.events.emit('builder.start', job.data);
	helpers.docs(job.data, function(err, docs) {
		if (err) {
			kue.events.emit('builder.error', err);
			return done(err);
		}

		docs.stdSystem = logs.create({
			source : 'system',
			channel : 'build.0',
			session : docs.app.logSession,
			bufferSize : 1
		});
		docs.stdSystem.log('build started');

		build(job, docs, done);
	});
});

