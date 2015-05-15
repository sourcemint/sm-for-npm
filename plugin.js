
const PATH = require("path");
const FS = require("fs-extra");
const FSWALKER = require("fswalker");
const CRYPTO = require("crypto");
const SPAWN = require("child_process").spawn;
const JSON_STABLE_STRINGIFY = require("json-stable-stringify");
const GLOB = require("glob");
const PACKAGE_INSIGHT = require("pinf-it-package-insight");
const WAITFOR = require("waitfor");


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
    	if (!process.env.PGS_PINF_EPOCH) {
    		throw new Error("'PGS_PINF_EPOCH' environment variable is not set!");
    	}
    	return callback(null, PATH.join(cacheDirpath, process.env.PGS_PINF_EPOCH));
    }


    return establishContext(cacheDirpath, function (err, cacheDirpath) {
    	if (err) return callback(err);

    	// TODO: Move to org.sourcemint.genesis.lib
	    function restoreInstallFromCache (hash, callback) {
			var archivePath = PATH.join(cacheDirpath, hash);
			return FS.exists(archivePath, function (exists) {
				if (!exists) {
					return callback(null, false);
				}
				log("Restoring install '" + basePath + "' from cache '" + archivePath + "'");
				var proc = SPAWN("rsync", [
					"-av",
					"./",
					basePath
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
					return callback(null);
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

    	// TODO: Move to org.sourcemint.genesis.lib
	    function createSnapshot (hash, paths, callback) {
			log("Creating snapshot for: " + basePath);

			var archivePath = PATH.join(cacheDirpath, hash);

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

					var fileListPath = toPath + ".files.txt~tmp";

					return FS.outputFile(fileListPath, paths.map(function (path) {
						return path.substring(1);
					}).join("\n"), function (err) {
						if (err) return callback(err);
						var proc = SPAWN("rsync", [
							"-av",
							"--files-from=" + fileListPath,
							"./",
							toPath
						], {
							cwd: fromPath
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
							return callback(null);
						});
					});
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

					log("Taking live '" + tmpPath + "' by moving to '" + archivePath + "'");

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

	    function indexAvailablePackages (callback) {
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
							return goUp(callback);
						});
					}
					return goUp(callback);
				});
			}

			return lookup(basePath, callback);
	    }

	    function linkAvailableDependencies (packages, callback) {
			return GLOB("**/package.json", {
				cwd: basePath
			}, function (err, filenames) {
				if (err) return callback(err);
				if (filenames.length === 0) {
					return callback(null);
				}
				var waitfor = WAITFOR.parallel(callback);
				filenames.forEach(function (filename) {
					return waitfor(function (callback) {
						return PACKAGE_INSIGHT.parseDescriptor(PATH.join(basePath, filename), {
							rootPath: basePath
						}, function(err, descriptor) {
							if (err) return callback(err);
							var waitfor = WAITFOR.parallel(callback);
							if (descriptor.normalized.dependencies) {
								for (var dependencyType in descriptor.normalized.dependencies) {
									for (var dependencyName in descriptor.normalized.dependencies[dependencyType]) {

										// If package is found in available packages we symlink it
										// so that 'npm' skips installing it when it runs.
										if (packages[dependencyName]) {
											waitfor(
												dependencyName,
												filename,
												function (dependencyName, filename, callback) {
													var sourcePath = packages[dependencyName];
													var targetPath = PATH.join(basePath, filename, "../node_modules", dependencyName);
													return FS.exists(targetPath, function (exists) {
														if (exists) return callback(null);

														function ensureTargetDirpathExists (callback) {
															var targetDirpath = PATH.dirname(targetPath);
															return FS.exists(targetDirpath, function (exists) {
																if (exists) return callback(null);
																return FS.mkdirs(targetDirpath, callback);
															});
														}

														return ensureTargetDirpathExists(function (err) {
															if (err) return callback(err);

															log("Symlinking dependency for package '" + dependencyName + "' from '" + sourcePath + "' to '" + targetPath + "'");

															// TODO: Test version and other aspect compatibilty and pick best source version
															//       If not matching version is available error out or continue if ignoring.

															return FS.symlink(sourcePath, targetPath, callback);
														});														
													});
												}
											);
										}
									}
								}
							}
							return waitfor();
						});
					});
				});
				return waitfor();
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

						return indexAvailablePackages(function (err, packages) {
							if (err) return callback(err);

							return linkAvailableDependencies(packages, function (err) {
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
			});
		});
    });
}
