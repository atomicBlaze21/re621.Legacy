const fs = require("fs");
const util = require("./util");

const headerData = JSON.parse(fs.readFileSync("./bin/userscript-header.json")),
    package = JSON.parse(fs.readFileSync("./package.json")),
    mode = process.argv[2] ? process.argv[2] : "build",
    browser = process.argv[3] ? process.argv[3] : "chrome";

// Create the userscript header
let header = "";
for (let [key, value] of Object.entries(headerData)) {
    if (Array.isArray(value)) {
        value.forEach((subValue) => { header += formateHeaderLine(key, subValue);; });
    } else if (typeof value === "object" && value !== null) {
        for (let [subKey, subValue] of Object.entries(value))
            header += formateHeaderLine(key, subKey, subValue);
    } else {
        // assume string
        header += formateHeaderLine(key, value);
    }
}

fs.createReadStream("./build/style.min.css").pipe(fs.createWriteStream("./build/userscript/style.min.css"));

switch (mode) {
    case "injector": {
        // Injector script
        header = header
            .replace(/(\/\/ @name[ ]+)(.+)/, "$1re621 Injector")
            .replace(/\/\/ @updateURL.*\n/, "")
            .replace(/\/\/ @downloadURL.*\n/, "")
            .replace(/(\/\/ @resource[ ]+re621_css )(.+)/, browser == "chrome" ? "$1file://" + __dirname + "\\..\\build\\userscript\\style.min.css" : "$1http://localhost:7000/style.min.css");
        header += formateHeaderLine("require", browser == "chrome" ? "file://" + __dirname + "\\..\\build\\userscript\\script.user.js" : "http://localhost:7000/script.user.js");
        fs.writeFileSync("./build/userscript/injector.user.js", util.parseTemplate("// ==UserScript==\n" + header + "// ==/UserScript==\n", package));
        break;
    }
    case "prod": {
        // Metadata file
        fs.writeFileSync(
            "./build/userscript/script.meta.js",
            util.parseTemplate("// ==UserScript==\n" + header + "// ==/UserScript==\n", package)
        );
    }
    default: {
        // Normal mode
        fs.writeFileSync(
            "./build/userscript/script.user.js",
            util.parseTemplate("// ==UserScript==\n" + header + "// ==/UserScript==\n", package) + "\n\n" +
            fs.readFileSync("./build/script.js")
        );
    }
}

function formateHeaderLine(a, b, c) {
    let output = "// @";
    while (a.length < 15) a += " ";
    output += a + " " + b;
    if (c !== undefined) output += " " + c;
    output += "\n";
    return output;
}
