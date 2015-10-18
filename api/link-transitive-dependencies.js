
const GLOB = require("glob");
const PACKAGE_INSIGHT = require("pinf-it-package-insight");



exports.for = function (API) {

	var exports = {};

	exports.PLFunction = function (basePath, packages) {

		return API.Q.denodeify(function (callback) {

			return GLOB("package.json", {
				cwd: basePath
			}, function (err, filenames) {
				if (err) return callback(err);
				if (filenames.length === 0) {
					return callback(null);
				}
				var waitfor = API.WAITFOR.parallel(callback);
				filenames.forEach(function (filename) {
					return waitfor(function (callback) {

						return PACKAGE_INSIGHT.parseDescriptor(API.PATH.join(basePath, filename), {
							rootPath: basePath
						}, function(err, descriptor) {
							if (err) {
								// Ignoring errors
								if (process.env.VERBOSE) {
									console.error("Warning: Error while parsing '" + API.PATH.join(basePath, filename) + "':", err.stack);
								}
								return callback(null);
							}
							var waitfor = API.WAITFOR.parallel(callback);
							var dependencyNames = {};
							if (descriptor.normalized.dependencies) {
								for (var dependencyType in descriptor.normalized.dependencies) {
									for (var dependencyName in descriptor.normalized.dependencies[dependencyType]) {

										// If package is found in available packages we symlink it
										// so that 'npm' skips installing it when it runs.
										if (
											packages[dependencyName] &&
											!dependencyNames[dependencyName]
										) {
											dependencyNames[dependencyName] = true;
											waitfor(
												dependencyName,
												filename,
												function (dependencyName, filename, callback) {
													var sourcePath = packages[dependencyName];
													var targetPath = API.PATH.join(basePath, filename, "../node_modules", dependencyName);
													return API.FS.exists(targetPath, function (exists) {
														if (exists) {
															if (API.FS.lstatSync(targetPath).isSymbolicLink()) {
																return callback(null);
															} else {
																API.FS.removeSync(targetPath);
															}
														}

														function ensureTargetDirpathExists (callback) {
															var targetDirpath = API.PATH.dirname(targetPath);
															return API.FS.exists(targetDirpath, function (exists) {
																if (exists) return callback(null);
																return API.FS.mkdirs(targetDirpath, callback);
															});
														}

														return ensureTargetDirpathExists(function (err) {
															if (err) return callback(err);

															if (process.env.VERBOSE) {
																console.log("Symlinking dependency for package '" + dependencyName + "' from '" + sourcePath + "' to '" + targetPath + "'");
															}

															// TODO: Test version and other aspect compatibilty and pick best source version
															//       If not matching version is available error out or continue if ignoring.

															return API.FS.symlink(
																API.PATH.relative(API.PATH.dirname(targetPath),  sourcePath),
																targetPath,
																callback
															);
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
		})();
	}

	return exports;
}
