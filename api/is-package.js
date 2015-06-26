
exports.for = function (API) {

	var exports = {};

	exports.PLFunction = function (paths) {

		var info = {};

		return API.Q.all(paths.map(function (path) {
			return API.QFS.exists(API.PATH.join(path, "node_modules")).then(function (exists) {
				info[path] = exists;
			});
		})).then(function () {

			return info;
		});
	}

	return exports;
}
