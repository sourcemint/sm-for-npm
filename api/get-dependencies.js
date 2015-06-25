
exports.for = function (API) {

	var exports = {};

	exports.PLFunction = function (basePath) {

		return API.Q.denodeify(function (callback) {

			var descriptorPath = API.PATH.join(basePath, "package.json");

			return require("pinf-it-package-insight").parseDescriptor(descriptorPath, {
				rootPath: basePath
			}, function(err, descriptor) {
				if (err) {
					// Ignoring errors
					if (process.env.VERBOSE) {
						console.error("Warning: Error while parsing '" + descriptorPath + "':", err.stack);
					}
					return callback(null);
				}

				return callback(null, descriptor.normalized.dependencies);
			});
		})();
	}

	return exports;
}
