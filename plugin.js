
const PATH = require("path");
const FS = require("fs-extra");
const Q = require("q");
const FSWALKER = require("fswalker");
const CRYPTO = require("crypto");
const SPAWN = require("child_process").spawn;
const JSON_STABLE_STRINGIFY = require("json-stable-stringify");
const GLOB = require("glob");
const PACKAGE_INSIGHT = require("pinf-it-package-insight");
const WAITFOR = require("waitfor");
const SEMVER = require("semver");


function makeAPI (basePath, options) {

	function log (message) {
		if (options && options.verbose) {
			console.log("[smi-for-npm]", message);
		}
	}

	var exports = {};

    exports.indexAvailablePackages = function (callback) {
    	// TODO: Use 'pinf-it-package-insight' data if it is available instead of looking ourselves.
    	// TODO: Embed 'pinf-it-package-insight' plugin for nodejs here instead of duplicating code below.
    	var packages = {};
		// Lookup all packages not already found in parent directories.
		function lookup (basePath, callback) {
			var lookupPath = PATH.join(basePath, "node_modules");
			return FS.exists(lookupPath, function (exists) {
				function goUp (callback) {
					if (PATH.dirname(basePath) === basePath) {
						return callback(null, packages);
					}
					return lookup(PATH.dirname(basePath), callback);
				}
				if (exists) {
					return FS.readdir(lookupPath, function (err, filenames) {
						if (err) return callback(err);
						filenames.forEach(function (filename) {
							if (/^\./.test(filename)) return;
							// TODO: Exclude directories.
							if (!packages[filename]) {
								packages[filename] = PATH.join(lookupPath, filename);
							}
						});
						filenames.forEach(function (filename) {
							if (/^\./.test(filename)) return;
							// 'smi' compatibility where temporary dirs get created during install.
							if (
								/-[a-z0-9]{7}$/.test(filename) &&
								!packages[filename.substring(0, filename.length-8)]
							) {
								packages[filename.substring(0, filename.length-8)] = PATH.join(lookupPath, filename);
							}
						});
						return goUp(callback);
					});
				}
				return goUp(callback);
			});
		}

		return lookup(PATH.dirname(basePath), callback);
    }

    exports.linkAvailableDependencies = function (packages, callback) {
		return require("./api/link-dependencies").for({
			PATH: PATH,
			FS: FS,
			WAITFOR: WAITFOR,
			Q: Q
		}).PLFunction(basePath, packages).then(function () {
			return callback(null);
		}, callback);
    }

    return exports;
}


exports.relink = function (basePath, options, callback) {

	options = options || {};

	var api = makeAPI(basePath, options);

	return api.indexAvailablePackages(function (err, packages) {
		if (err) return callback(err);

		return api.linkAvailableDependencies(packages, function (err) {
			if (err) return callback(err);

			return callback(null);
		});
	});
}


exports.install = function (basePath, options, callback) {

	options = options || {};

	var api = makeAPI(basePath, options);

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
    	// Index files but not dependencies.
    	// Use pinf-it-package-insight to determine dependencies.
        var walker = new FSWALKER.Walker(basePath);
        var opts = {};
        opts.ignore = [
        	"/node_modules/"
        ];
        opts.returnIgnoredFiles = false;
        opts.returnIgnoredFilesInPaths = true;
        opts.includeDependencies = false;
        opts.respectDistignore = false;
        opts.respectNestedIgnore = false;
        opts.excludeMtime = true;
        return walker.walk(opts, function (err, paths, summary) {
        	if (err) return callback(err);
        	var hash = {};
        	// TODO: Possibly detect more changes.
        	Object.keys(paths).forEach(function (path) {
        		if (/^\/node_modules(\/|$)/.test(path)) {
        			return;
        		}
            	hash[path] = paths[path].size;
            });
			return PACKAGE_INSIGHT.parseDescriptor(PATH.join(basePath, 'package.json'), {
				rootPath: basePath
			}, function(err, descriptor) {
				if (err) return callback(err);

//console.log("paths", basePath, paths);
	        	return callback(null, {
	                paths: paths,
	                summary: summary,
	                pathsHash: CRYPTO.createHash("md5").update(JSON_STABLE_STRINGIFY(hash)).digest("hex"),
	                dependenciesHash: CRYPTO.createHash("md5").update(JSON_STABLE_STRINGIFY(descriptor.normalized.dependencies || {})).digest("hex")
	            });
		    });
        });
    }

    function establishContext (cacheDirpath, callback) {
    	// TODO: Create insight context.
    	// IO: Archives are stored in the 'cacheDirpath' grouped by the 'PGS_PINF_EPOCH'.
    	// ASSUMPTION: It is assumed that symlinks stored in archives will continue to
    	//             work upon extraction. This should always work for relative symlinks.
    	// POLICY: It should also work for absolute symlinks if all users use the same
    	//         root path to the development workspace being archived.
    	//         Keep symlinks relative and within the development workspace and you will have no problems.
    	//         If symlinks reach out of the system they should be configurable via the
    	//         workspace activation (<WorkspaceBasename>.activate.sh) or
    	//         workspace profile (<WorkspaceBasename>.profile.json) files.
    	var group = null;
    	if (process.env.PGS_PINF_EPOCH) {
    		group = process.env.PGS_PINF_EPOCH;
    	} else {
    		group = "x";
    		// TODO: Optionally throw.
    		//throw new Error("'PGS_PINF_EPOCH' environment variable is not set!");
    	}
    	return callback(null, PATH.join(cacheDirpath, group));
    }


    return establishContext(cacheDirpath, function (err, cacheDirpath) {
    	if (err) return callback(err);

    	// TODO: Move to org.sourcemint.genesis.lib
	    function restoreInstallFromCache (info, callback) {
			function copy (archivePath, toPath, callback) {
				return FS.exists(archivePath, function (exists) {
					if (!exists) {
						return callback(null, false);
					}
					log("Restoring install '" + toPath + "' from cache '" + archivePath + "'");
					var proc = SPAWN("rsync", [
						"-a",
						".",
						toPath
					], {
						cwd: archivePath
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
							console.error("ERROR: rsync exited with code '" + code + "'");
							return callback(new Error("rsync exited with code '" + code + "' and stderr: " + stderr.join("")));
						}
						return callback(null, true);
					});
					/*
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
					*/
				});				
			}

			function restoreDependencies (callback) {
				return copy(
					PATH.join(cacheDirpath, info.dependenciesHash + "-dependencies"),
					PATH.join(basePath, "node_modules"),
					callback
				);
			}

			function restoreInstallChanges (callback) {
				return copy(
					PATH.join(cacheDirpath, info.pathsHash + "-changes"),
					basePath,
					callback
				);
			}

			return restoreDependencies(function (err) {
				if (err) return callback(err);

				return restoreInstallChanges(callback);
			});
	    }

    	// TODO: Move to org.sourcemint.genesis.lib
	    function createSnapshot (info, paths, callback) {

			function create (archivePath, paths, callback) {

				log("Creating snapshot for: " + basePath);

				return FS.exists(archivePath, function (exists) {
					if (exists) {
						return callback(null);
					}
					log("Copying to cache from '" + basePath + "' to '" + archivePath + "'");
					if (!FS.existsSync(PATH.dirname(archivePath))) {
						FS.mkdirsSync(PATH.dirname(archivePath));
					}
					var tmpPath = archivePath + "~tmp";
					if (FS.existsSync(tmpPath)) {
						FS.removeSync(tmpPath);
					}
					function copyFiles (fromPath, toPath, callback) {

						if (typeof paths === "string") {
							var proc = SPAWN("cp", [
								"-Rf",
								paths,
								toPath
							], {
								cwd: fromPath
							});
							proc.on('error', function (err) {
								console.error("BUT IGNORING ERROR", err.stack);
								// TODO: Record error so we can investigate later.
								return FS.remove(toPath, function (err) {
									return callback(null);
								});
							});
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
									console.error("ERROR: rsync exited with code '" + code + "'");
									console.error("BUT IGNORING ERROR", new Error("rsync exited with code '" + code + "' and stderr").stack);
									// TODO: Record error so we can investigate later.
									return FS.remove(toPath, function (err) {
										return callback(null);
									});
//									return callback(new Error("rsync exited with code '" + code + "' and stderr: " + stderr.join("")));
								}
								return callback(null);
							});

						} else {

							if (paths.length === 0) {
								return FS.mkdir(toPath, function (err) {
									if (err) return callback(err);
									return callback(null);
								});
							}

							var fileListPath = toPath + ".files.txt~tmp";
							return FS.outputFile(fileListPath, paths.map(function (path) {
								return path.substring(1);
							}).join("\n"), function (err) {
								if (err) return callback(err);
								var proc = SPAWN("rsync", [
									"-a",
									"--files-from=" + fileListPath,
									"./",
									toPath
								], {
									cwd: fromPath
								});
								proc.on('error', function (err) {
									console.error("BUT IGNORING ERROR", err.stack);
									// TODO: Record error so we can investigate later.
									return FS.remove(toPath, function (err) {
										return FS.remove(fileListPath, callback);
									});
								});
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
										console.error("ERROR: rsync exited with code '" + code + "'");
										console.error("BUT IGNORING ERROR", new Error("rsync exited with code '" + code + "' and stderr").stack);
										// TODO: Record error so we can investigate later.
										return FS.remove(toPath, function (err) {
											return FS.remove(fileListPath, callback);
										});
//										return callback(new Error("rsync exited with code '" + code + "' and stderr: " + stderr.join("")));
									}
									// TODO: Optionally keep file as simple manifest
									return FS.remove(fileListPath, callback);
								});
							});
						}
						/*
						TODO: Optionally use 'ncp'
							var includedPaths = {};
							paths.forEach(function (path) {
								includedPaths[path] = true;
							});
		console.log("includedPaths", includedPaths);
							NCP.ncp.limit = 16;
							return NCP.ncp(fromPath, toPath, {
								dereference: false,
								clobber: true,
								filter: function (path) {
									var subpath = path.substring(fromPath.length);
		console.log("check path", subpath);							
									if (!subpath) return true;

									if (includedPaths[subpath]) {
										console.log("found !! PATH", subpath);
										return true;
									} else {
										console.log("NOT FOUND PATH", subpath);
										return false;
									}
								}
							}, function (err) {
								if (err) {
									console.error(err);
									return callback(new Error("Error copying files."));
								}
								return callback(null);
							});
						*/
					}
					return copyFiles(basePath, tmpPath, function (err) {
						if (err) return callback(err);

						if (!FS.existsSync(tmpPath)) {
							log("Skip freezing snapshot '" + tmpPath + "' by moving to '" + archivePath + "' as snapshot was not created!");
							return callback();
						}

						log("Freezing snapshot '" + tmpPath + "' by moving to '" + archivePath + "'");

						return FS.move(tmpPath, archivePath, callback);
					});

	/*
					// TODO: Optionally compress in seperate process once copied.
					var proc = SPAWN("tar", [
						"-cz",
						"-C", basePath,
						"-f", PATH.basename(archivePath) + "~tmp",
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
	*/
				});
			}

			function snapshotDependencies (callback) {
				return FS.exists(PATH.join(basePath, "node_modules"), function (exists) {
					if (!exists) return callback(null);
					return create(
						PATH.join(cacheDirpath, info.dependenciesHash + "-dependencies"),
						"node_modules",
						callback
					);
				});
			}

			function snapshotInstallChanges (callback) {
				return create(
					PATH.join(cacheDirpath, info.pathsHash + "-changes"),
					paths,
					callback
				);
			}

			return snapshotDependencies(function (err) {
				if (err) return callback(err);

				return snapshotInstallChanges(callback);
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

					return restoreInstallFromCache(dirtreeBefore, function (err, installed) {
						if (err) return callback(err);
						if (installed) {
							log("Installed from cache");
							return callback(null);
						}

						return api.indexAvailablePackages(function (err, packages) {
							if (err) return callback(err);

//							log("Found available packages: " + JSON.stringify(packages, null, 4));

							return api.linkAvailableDependencies(packages, function (err) {
								if (err) return callback(err);

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
										return createSnapshot(dirtreeBefore, paths, function (err) {
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
			});
		});
    });
}


/*

TODO: Remove
DEPRECATED: This is now done by `sm.contract`.

    "github.com/sourcemint/smi-for-npm/0": {
        "$to": "smi-npm-catalog",
        "declaredMappings": "{{$from.smi-git-catalog.declaredMappings}}",
        "export": {
            "catalog": "{{env.PGS_WORKSPACE_ROOT}}/smi.json"
        }
    }


exports.for = function (API) {

	var exports = {};

	exports.resolve = function (resolver, config, previousResolvedConfig) {

		return resolver({}).then(function (resolvedConfig) {

			resolvedConfig.transitiveDependencies = {};

			function addDepsForBasePath (basePath) {
				// TODO: Do much smarter version comparison and verification instead of clobbering.
				//       We can write multiple packages using '~\d' suffix and re-write descriptor
				//       to map new package to old path.
				var descriptorPath = API.PATH.join(basePath, "package.json");
				if (API.FS.existsSync(descriptorPath)) {
					var descriptor = JSON.parse(API.FS.readFileSync(descriptorPath, "utf8"));
					if (descriptor.dependencies) {
						for (var name in descriptor.dependencies) {
							var descriptorPath = API.PATH.join(basePath, "node_modules", name, "package.json");
							if (API.FS.existsSync(descriptorPath)) {
								var version = require(descriptorPath).version;
								if (
									!resolvedConfig.transitiveDependencies[name] ||
									SEMVER.gt(version, resolvedConfig.transitiveDependencies[name])
								) {
									resolvedConfig.transitiveDependencies[name] = version;
								}
							}
						}
					}
					// TODO: Also relocate 'descriptor.mappings'.
				}
			}

			if (resolvedConfig.declaredMappings) {
				for (var alias in resolvedConfig.declaredMappings) {
					addDepsForBasePath(resolvedConfig.declaredMappings[alias].path);
				}
			}

			return API.Q.denodeify(function (callback) {

				return API.PACKAGE.fromFile(API.PATH.join(process.env.PGS_WORKSPACE_ROOT, ".pgs/package.json"), {}, function (err, packageDescriptor) {
					if (err) return callback(err);

					if (packageDescriptor._data.dependencies) {
						// TODO: Index and add.
					}

					return callback(null);
				});

			})().then(function () {

				return resolvedConfig;
			});
		});
	}

	exports.turn = function (resolvedConfig) {

		if (
			!resolvedConfig.export ||
			!resolvedConfig.export.catalog ||
			!resolvedConfig.transitiveDependencies
		) {
			return API.Q.resolve();
		}


		function exportDependencies (dependencies) {

			return API.Q.denodeify(function (callback) {

				var descriptor = {
					"dependencies": dependencies
				};

				if (API.FS.existsSync(resolvedConfig.export.catalog)) {
					descriptor = API.DEEPMERGE(
						JSON.parse(API.FS.readFileSync(resolvedConfig.export.catalog, "utf8")),
						descriptor
					);
				}

				return API.FS.outputFile(
					resolvedConfig.export.catalog,
					JSON.stringify(descriptor, null, 4),
					"utf8",
					callback
				);
			})();
		}

		return exportDependencies(resolvedConfig.transitiveDependencies);
	}

	return exports;
}

*/
