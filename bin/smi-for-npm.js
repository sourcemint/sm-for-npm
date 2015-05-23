
const PLUGIN = require("../plugin");


var offset = process.argv.indexOf("install");
if (offset > 0) {

    PLUGIN.install(process.cwd(), {
        // TODO: Use a better parser here.
        args: process.argv.slice(offset + 1),
        verbose: (process.env.VERBOSE === "1")
    }, function (err) {
        if (err) {
            console.error(err.stack);
            process.exit(1);
        }
        process.exit(0);
    });
} else
if (process.argv[2] === "relink") {

    PLUGIN.relink(process.cwd(), {
        // TODO: Use a better parser here.
        args: process.argv.slice(offset + 1),
        verbose: (process.env.VERBOSE === "1")
    }, function (err) {
        if (err) {
            console.error(err.stack);
            process.exit(1);
        }
        process.exit(0);
    });
} else {

    throw new Error("Only 'smi-for-npm install' is currently implemented.");

}
