

exports.for = function (API) {

	var exports = {};

	exports.PLFunction = function (basePath) {

		return API.Q.denodeify(function (callback) {

			if (process.env.VERBOSE) console.log("Installing with 'npm': " + basePath);

			if (!API.FS.existsSync(API.PATH.join(basePath, "package.json"))) {
				return callback(new Error("Cannot install package '" + basePath + "' as no package.json found!"));
			}

			var proc = API.SPAWN("npm", [
				"install",
				"--production",
				"--unsafe-perm"
			], {
				cwd: basePath
			});
			proc.on('error', callback);
			proc.stdout.on('data', function (data) {
				if (process.env.VERBOSE) {
					process.stdout.write(data);
				}
			});
			var stderr = [];
			proc.stderr.on('data', function (data) {
				stderr.push(data.toString());
				if (process.env.VERBOSE) {
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
		})();
	}

	return exports;
}

