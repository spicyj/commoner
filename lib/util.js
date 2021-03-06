var assert = require("assert");
var path = require("path");
var fs = require("graceful-fs");
var Q = require("q");
var createHash = require("crypto").createHash;
var mkdirp = require("mkdirp");
var Ap = Array.prototype;
var slice = Ap.slice;
var join = Ap.join;

// The graceful-fs module attempts to limit the total number of open files
// by queueing fs operations, but it doesn't know about all open files, so
// we set the limit somewhat lower than the default to provide a healthy
// buffer against EMFILE (too many open files) errors.
fs.MAX_OPEN = 512;

function makePromise(callback, context) {
    var deferred = Q.defer();

    function finish(err, result) {
        if (err) {
            deferred.reject(err);
        } else {
            deferred.resolve(result);
        }
    }

    process.nextTick(function() {
        try {
            callback.call(context || null, finish);
        } catch (err) {
            finish(err);
        }
    });

    return deferred.promise;
}
exports.makePromise = makePromise;

exports.cachedMethod = function(fn, keyFn) {
    var p = require("private").makeAccessor();

    function wrapper() {
        var priv = p(this);
        var cache = priv.cache || (priv.cache = {});
        var args = arguments;
        var key = keyFn
            ? keyFn.apply(this, args)
            : join.call(args, "\0");
        return cache.hasOwnProperty(key)
            ? cache[key]
            : cache[key] = fn.apply(this, args);
    }

    wrapper.originalFn = fn;

    return wrapper;
};

function readFileP(file) {
    return makePromise(function(callback) {
        return fs.readFile(file, "utf8", callback);
    });
}
exports.readFileP = readFileP;

exports.readJsonFileP = function(file) {
    return readFileP(file).then(function(json) {
        return JSON.parse(json);
    });
};

exports.mkdirP = function(dir) {
    return makePromise(function(callback) {
        mkdirp(dir, function(err) {
            callback(err, dir);
        });
    });
};

exports.acquireLockFileP = function(file) {
    return openExclusiveP(file).then(function(fd) {
        function unlink(code) {
            if (!unlink.ed) {
                unlink.ed = true;

                try {
                    fs.unlinkSync(file);
                } catch (e) {
                    if (e.code === "ENOENT") {
                        // Don't worry if lock file was deleted.
                    } else {
                        log.err(e.stack);
                    }
                }

                process.exit(~~code);
            }
        }

        process.on("exit", unlink);
        process.on("SIGINT", unlink);
        process.on("SIGTERM", unlink);

        return writeFdP(fd, process.pid + "\n");
    });
};

function readFromStdinP(timeLimit, message, color) {
    var deferred = Q.defer();
    var stdin = process.stdin;
    var ins = [];

    stdin.resume();
    stdin.setEncoding("utf8");

    timeLimit = timeLimit || 1000;
    var timeout = setTimeout(function() {
        log.err(
            message || ("Warning: still waiting for STDIN after " +
                        timeLimit + "ms"),
            color || "yellow"
        );
    }, timeLimit);

    stdin.on("data", function(data) {
        ins.push(data);
    }).on("end", function() {
        clearTimeout(timeout);
        deferred.resolve(ins.join(""));
    });

    return deferred.promise;
}
exports.readFromStdinP = readFromStdinP;

exports.readJsonFromStdinP = function(timeLimit) {
    return readFromStdinP(timeLimit).then(function(input) {
        return JSON.parse(input);
    });
};

function deepHash(val) {
    var hash = createHash("sha1");
    var type = typeof val;

    if (val === null) {
        type = "null";
    }

    switch (type) {
    case "object":
        Object.keys(val).sort().forEach(function(key) {
            hash.update(key + "\0")
                .update(deepHash(val[key]));
        });
        break;

    case "function":
        assert.ok(false, "cannot hash function objects");
        break;

    default:
        hash.update(val + "");
        break;
    }

    return hash.digest("hex");
}
exports.deepHash = deepHash;

exports.existsP = function(fullPath) {
    return makePromise(function(callback) {
        fs.exists(fullPath, function(exists) {
            callback(null, exists);
        });
    });
};

function writeFdP(fd, content) {
    return makePromise(function(callback) {
        content += "";
        var buffer = new Buffer(content, "utf8");
        var length = fs.writeSync(fd, buffer, 0, buffer.length, null);
        assert.strictEqual(length, buffer.length);
        callback(null, content);
    }).fin(function() {
        fs.closeSync(fd);
    });
}
exports.writeFdP = writeFdP;

function openFileP(file, mode) {
    return makePromise(function(callback) {
        fs.open(file, mode || "w+", callback);
    });
}
exports.openFileP = openFileP;

function openExclusiveP(file) {
    // The 'x' in "wx+" means the file must be newly created.
    return openFileP(file, "wx+");
}
exports.openExclusiveP = openExclusiveP;

exports.copyP = function(srcFile, dstFile) {
    return makePromise(function(callback) {
        var reader = fs.createReadStream(srcFile);

        function onError(err) {
            callback(err || new Error(
                "error in util.copyP(" +
                    JSON.stringify(srcFile) + ", " +
                    JSON.stringify(dstFile) + ")"
            ));
        }

        reader.on("error", onError).pipe(
            fs.createWriteStream(dstFile)
        ).on("finish", function() {
            callback(null, dstFile);
        }).on("error", onError);
    });
};

// Even though they use synchronous operations to avoid race conditions,
// linkP and unlinkP have promise interfaces, for consistency. Note that
// this means the operation will not happen until at least the next tick
// of the event loop, but it will be atomic when it happens.
exports.linkP = function(srcFile, dstFile) {
    return makePromise(function(callback) {
        try {
            if (fs.existsSync(dstFile))
                fs.unlinkSync(dstFile);
            fs.linkSync(srcFile, dstFile);
            callback(null, dstFile);
        } catch (err) {
            callback(err);
        }
    });
};

exports.unlinkP = function(file) {
    return makePromise(function(callback) {
        try {
            if (fs.existsSync(file))
                fs.unlinkSync(file);
            callback(null, file);
        } catch (err) {
            callback(err);
        }
    });
};

var colors = {
    bold: "\033[1m",
    red: "\033[31m",
    green: "\033[32m",
    yellow: "\033[33m",
    cyan: "\033[36m",
    reset: "\033[0m"
};

Object.keys(colors).forEach(function(key) {
    if (key !== "reset") {
        exports[key] = function(text) {
            return colors[key] + text + colors.reset;
        };
    }
});

var log = exports.log = {
    out: function(text, color) {
        text = (text + "").trim();
        if (colors.hasOwnProperty(color))
            text = colors[color] + text + colors.reset;
        process.stdout.write(text + "\n");
    },

    err: function(text, color) {
        text = (text + "").trim();
        if (!colors.hasOwnProperty(color))
            color = "red";
        text = colors[color] + text + colors.reset;
        process.stderr.write(text + "\n");
    }
};

var slugExp = /[^a-z\-]/ig;
exports.idToSlug = function(id) {
    return id.replace(slugExp, "_");
};

var moduleIdExp = /^[a-z0-9\-_\/\.]+$/i;
exports.isValidModuleId = function(id) {
    return id === "<stdin>" || moduleIdExp.test(id);
};

var objToStr = Object.prototype.toString;
var arrStr = objToStr.call([]);

function flatten(value, into) {
    if (objToStr.call(value) === arrStr) {
        into = into || [];
        for (var i = 0, len = value.length; i < len; ++i)
            if (i in value) // Skip holes.
                flatten(value[i], into);
    } else if (into) {
        into.push(value);
    } else {
        return value;
    }

    return into;
};
exports.flatten = flatten;

exports.inherits = function(ctor, base) {
    return ctor.prototype = Object.create(base.prototype, {
        constructor: { value: ctor }
    });
};

function absolutize(moduleId, requiredId) {
    if (requiredId.charAt(0) === ".")
        requiredId = path.join(moduleId, "..", requiredId);
    return path.normalize(requiredId);
}
exports.absolutize = absolutize;

function relativize(moduleId, requiredId) {
    requiredId = absolutize(moduleId, requiredId);

    if (requiredId.charAt(0) === ".") {
        // Keep the required ID relative.
    } else {
        // Relativize the required ID.
        requiredId = path.relative(
            path.join(moduleId, ".."),
            requiredId
        );
    }

    if (requiredId.charAt(0) !== ".")
        requiredId = "./" + requiredId;

    return requiredId;
}
exports.relativize = relativize;
