// CI helper: reports whether package.json's version is already on npm, and refuses a name owned by another project.
import { readFileSync, appendFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`);
if (![200, 404].includes(res.status)) throw new Error(`Registry check failed: ${res.status}`);
if (res.status === 200 && (await res.json()).repository?.url !== pkg.repository.url) throw new Error("That version belongs to a different project; check the package name.");
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${pkg.version}\npublished=${res.status === 200}\n`);
else console.log(`${pkg.name}@${pkg.version} ${res.status === 200 ? "is published" : "is not published yet"}`);
