
const PACKAGE_INSIGHT = require("pinf-it-package-insight");

exports.for = function (API) {

	var exports = {};

	exports.PLFunction = function (basePath, packages) {

		var descriptorPath = API.PATH.join(basePath, "package.json");

		return require("./get-dependencies").for(API).PLFunction(basePath).then(function (dependencies) {

			if (!dependencies) return;

			return API.Q.denodeify(function (callback) {

				var waitfor = API.WAITFOR.parallel(callback);
				var dependencyNames = {};
				for (var dependencyType in dependencies) {
					for (var dependencyName in dependencies[dependencyType]) {

						// If package is found in available packages we symlink it
						// so that 'npm' skips installing it when it runs.
						if (
							packages[dependencyName] &&
							!dependencyNames[dependencyName]
						) {
							dependencyNames[dependencyName] = true;
							waitfor(
								dependencyName,
								function (dependencyName, callback) {
									var sourcePath = packages[dependencyName];
									var targetPath = API.PATH.join(descriptorPath, "../node_modules", dependencyName);
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

											return API.FS.symlink(sourcePath, targetPath, callback);
										});														
									});
								}
							);
						}
					}
				}
				return waitfor();
			})();
		});
	}

	return exports;
}
