
const PATH = require("path");
const FS = require("fs-extra");
const FSWALKER = require("fswalker");
const CRYPTO = require("crypto");
const SPAWN = require("child_process").spawn;
const JSON_STABLE_STRINGIFY = require("json-stable-stringify");


exports.install = function (basePath, options, callback) {

	options = options || {};

	var cacheDirpath = null;
	if (!options.cacheBasePath) {
		if (!process.env.SMI_CACHE_DIRPATH) {
			return callback(new Error("No 'options.cacheBasePath' nor 'SMI_CACHE_DIRPATH' environment variable set!"));
		}
		cacheDirpath = process.env.SMI_CACHE_DIRPATH;
	} else {
		cacheDirpath = options.cacheBasePath;
	}

	function log (message) {
		if (options && options.verbose) {
			console.log("[smi-for-npm]", message);
		}
	}

	var metaPath = PATH.join(basePath, ".smi-for-npm");
	var nodeModulesPath = PATH.join(basePath, "node_modules");
/*
	function readMeta (callback) {
		return FS.exists(metaPath, function (exists) {
			if (!exists) {
				return callback(null, null);
			}
			return FS.readFile(metaPath, "utf8", function (err, data) {
				if (err) return callback(err);
				return callback(null, JSON.parse(data));
			});
		});
	}
*/

	function removeMeta (callback) {
		return FS.exists(metaPath, function (exists) {
			if (!exists) return callback(null);
			return FS.remove(metaPath, callback);
		});
	}

	function writeMeta (meta, callback) {
		return FS.outputFile(metaPath, JSON.stringify(meta, null, 4), "utf8", callback);
	}

	function isInstalled (callback) {
		return FS.exists(nodeModulesPath, function (exists) {
			if (!exists) {
				return callback(null, false);
			}
			return FS.exists(metaPath, function (exists) {
				return callback(null, exists);
			});
		});
	}

    function indexDirtree (callback) {
        var walker = new FSWALKER.Walker(basePath);
        var opts = {};
        opts.returnIgnoredFiles = false;
        opts.returnIgnoredFilesInPaths = true;
        opts.includeDependencies = true;
        opts.respectDistignore = false;
        opts.respectNestedIgnore = false;
        opts.excludeMtime = false;
        return walker.walk(opts, function (err, paths, summary) {
        	if (err) return callback(err);
        	var hashFiles = {};
        	// TODO: Possibly detect more changes.
        	Object.keys(paths).forEach(function (path) {
        		if (/^\/node_modules(\/|$)/.test(path)) {
        			return;
        		}
            	hashFiles[path] = paths[path].size;
            });
        	return callback(null, {
                paths: paths,
                summary: summary,
                hash: CRYPTO.createHash("md5").update(JSON_STABLE_STRINGIFY(hashFiles)).digest("hex")
            });
        });
    }

    function restoreInstallFromCache (hash, callback) {
		var archivePath = PATH.join(cacheDirpath, hash + ".tgz");
		return FS.exists(archivePath, function (exists) {
			if (!exists) {
				return callback(null, false);
			}
			log("Extract archive '" + archivePath + "' to '" + basePath + "'");
			// TODO: Instead of extracting archive, first see if there is an expanded form.
			var proc = SPAWN("tar", [
				"-xz",
				"-C", basePath,
				"-f", PATH.basename(archivePath)
			], {
				cwd: PATH.dirname(archivePath)
			});
			proc.on('error', callback);
			proc.stdout.on('data', function (data) {
				process.stdout.write(data);
			});
			var stderr = [];
			proc.stderr.on('data', function (data) {
				stderr.push(data.toString());
				process.stderr.write(data);
			});
			return proc.on('close', function (code) {
				if (code !== 0) {
					console.error("ERROR: tar exited with code '" + code + "'");
					return callback(new Error("tar exited with code '" + code + "' and stderr: " + stderr.join("")));
				}
				return callback(null, true);
			});
		});
    }

    function createSnapshot (hash, paths, callback) {
		log("Creating snapshot for: " + basePath);

		var archivePath = PATH.join(cacheDirpath, hash + ".tgz");

		return FS.exists(archivePath, function (exists) {
			if (exists) {
				return callback(null);
			}
			log("Creating archive '" + archivePath + "' from '" + basePath + "'");
			if (!FS.existsSync(PATH.dirname(archivePath))) {
				FS.mkdirsSync(PATH.dirname(archivePath));
			}
			var tmpBasename = PATH.basename(archivePath) + "~tmp";
			var tmpPath = archivePath + "~tmp";
			if (FS.existsSync(tmpPath)) {
				FS.removeSync(tmpPath);
			}
			// TODO: Instead of creating archive, copy files.
			var proc = SPAWN("tar", [
				"-cz",
				"-C", basePath,
				"-f", tmpBasename,
				"-T",
				"-"
			], {
				cwd: PATH.dirname(archivePath)
			});
			proc.on('error', callback);
			proc.stdout.on('data', function (data) {
				process.stdout.write(data);
			});
			var stderr = [];
			proc.stderr.on('data', function (data) {
				stderr.push(data.toString());
				process.stderr.write(data);
			});
			proc.on('close', function (code) {
				if (code !== 0) {
					console.error("ERROR: tar exited with code '" + code + "'");
					return callback(new Error("tar exited with code '" + code + "' and stderr: " + stderr.join("")));
				}
				return FS.move(tmpPath, archivePath, callback);
			});
			proc.stdin.write(paths.map(function (path) {
				return path.substring(1);
			}).join("\n"));
            proc.stdin.end();
            return;
		});
    }

    function installWithNpm (callback) {
		log("Installing with 'npm': " + basePath);
		log("Commands: " + [
				"install"
			].concat(options.args || []).join(" "));
		var proc = SPAWN("npm", [
			"install"
		].concat(options.args || []), {
			cwd: basePath
		});
		proc.on('error', callback);
		proc.stdout.on('data', function (data) {
			if (options.verbose) {
				process.stdout.write(data);
			}
		});
		var stderr = [];
		proc.stderr.on('data', function (data) {
			stderr.push(data.toString());
			if (options.verbose) {
				process.stderr.write(data);
			}
		});
		return proc.on('close', function (code) {
			if (code !== 0) {
				console.error("ERROR: npm exited with code '" + code + "'");
				return callback(new Error("npm exited with code '" + code + "' and stderr: " + stderr.join("")));
			}
			return callback(null);
		});
    }

	log("Installing: " + basePath);

	return isInstalled(function (err, installed) {
		if (err) return callback(err);

		if (installed) {
			log("Already installed");
			return callback(null);
		}

		return removeMeta(function (err) {
			if (err) return callback(err);

			return indexDirtree(function (err, dirtreeBefore) {
				if (err) return callback(err);

				return restoreInstallFromCache(dirtreeBefore.hash, function (err, installed) {
					if (err) return callback(err);
					if (installed) {
						log("Installed from cache");
						return callback(null);
					}

					return installWithNpm(function (err) {
						if (err) return callback(err);

						return indexDirtree(function (err, dirtreeAfter) {
							if (err) return callback(err);

							// Get only new/changed paths
							// TODO: Track removed files as well. i.e. keep marker in archive and remove
							//       file after extracting.
							var paths = [];

							Object.keys(dirtreeAfter.paths).forEach(function (path) {
								if (
									dirtreeBefore.paths[path] &&
									dirtreeBefore.paths[path].mtime === dirtreeAfter.paths[path].mtime &&
									dirtreeBefore.paths[path].size === dirtreeAfter.paths[path].size
								) {
									// File not changed.
								} else {
									paths.push(path);
								}
							});

							// Store the set of created files for the original hash so that
							// when we install the next time we can look for an pre-existing
							// archive based on the 'dirtreeBefore.hash' created above.
							return createSnapshot(dirtreeBefore.hash, paths, function (err) {
								if (err) return callback(err);

								delete dirtreeBefore.paths;
								delete dirtreeAfter.paths;

								return writeMeta({
									before: dirtreeBefore,
									after: dirtreeAfter
								}, callback);
							});
						});
					});
				});
			});
		});
	});
}
