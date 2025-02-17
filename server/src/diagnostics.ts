import {
    Diagnostic,
    DiagnosticSeverity,
} from 'vscode-languageserver/node';
import { NavigatorSettings, CompilationResults, PerlDocument } from "./types";
import {
	WorkspaceFolder
} from 'vscode-languageserver-protocol';
import { dirname, join } from 'path';
import Uri from 'vscode-uri';
import { getIncPaths, async_execFile, nLog } from './utils';
import { buildNav } from "./parseDocument";
import { getPerlAssetsPath } from "./assets";

import {
    TextDocument
} from 'vscode-languageserver-textdocument';

export async function perlcompile(textDocument: TextDocument, workspaceFolders: WorkspaceFolder[] | null, settings: NavigatorSettings): Promise<CompilationResults | void> {
    let perlParams: string[] = ["-c"];
    const filePath = Uri.parse(textDocument.uri).fsPath;

    if(settings.enableWarnings) perlParams = perlParams.concat(["-Mwarnings", "-M-warnings=redefine"]); // Force enable some warnings.
    perlParams = perlParams.concat(getIncPaths(workspaceFolders, settings));
    perlParams = perlParams.concat(getInquisitor());
    nLog("Starting perl compilation check with the equivalent of: " + settings.perlPath + " " + perlParams.join(" ") + " " + filePath, settings);

    let output: string;
    let stdout: string;
    let severity: DiagnosticSeverity;
    const diagnostics: Diagnostic[] = [];
    const code = getAdjustedPerlCode(textDocument, filePath);
    try {
        const process = async_execFile(settings.perlPath, perlParams, {timeout: 10000, maxBuffer: 20 * 1024 * 1024});
        process?.child?.stdin?.on('error', (error: any) => { 
            nLog("Perl Compilation Error Caught: ", settings);
            nLog(error, settings);
        });
        process?.child?.stdin?.write(code);
        process?.child?.stdin?.end();
        const out = await process;

        output = out.stderr;
        stdout = out.stdout;
        severity = DiagnosticSeverity.Warning;
    } catch(error: any) {
        // TODO: Check if we overflowed the buffer.
        if("stderr" in error && "stdout" in error){
            output = error.stderr;
            stdout = error.stdout;
            severity = DiagnosticSeverity.Error;
        } else {
            nLog("Perlcompile failed with unknown error", settings);
            nLog(error, settings);
            return;
        }
    }

    const perlDoc = await buildNav(stdout);

    output.split("\n").forEach(violation => {
        maybeAddCompDiag(violation, severity, diagnostics, filePath, perlDoc);
    });
    return {diags: diagnostics, perlDoc: perlDoc};
}

function getInquisitor(): string[]{
    const inq_path = getPerlAssetsPath();
    let inq: string[] = ['-I', inq_path, '-MInquisitor'];
    return inq;
}

function getAdjustedPerlCode(textDocument: TextDocument, filePath: string): string {
    let code = textDocument.getText();
    code = `local \$0; use lib_bs22::SourceStash; BEGIN { \$0 = '${filePath}'; if (\$INC{'FindBin.pm'}) { FindBin->again(); }; \$lib_bs22::SourceStash::filename = '${filePath}'; print "Setting file" . __FILE__; }\n# line 0 \"${filePath}\"\ndie('Not needed, but die for safety');\n` + code;
    return code;
}

function maybeAddCompDiag(violation: string, severity: DiagnosticSeverity , diagnostics: Diagnostic[], filePath: string, perlDoc: PerlDocument): void {

    violation = violation.replace(/\r/g, ""); // Clean up for Windows
    violation = violation.replace(/, <STDIN> line 1\.$/g, ""); // Remove our stdin nonsense

    const lineNum = localizeErrors(violation, filePath, perlDoc);
    if (typeof lineNum == 'undefined') return;

    diagnostics.push({
        severity: severity,
        range: {
            start: { line: lineNum, character: 0 },
            end: { line: lineNum, character: 500 }
        },
        message: "Syntax: " + violation,
        source: 'perlnavigator'
    });
}


function localizeErrors (violation: string, filePath: string, perlDoc: PerlDocument): number | void {

    if(/Too late to run CHECK block/.test(violation)) return;

    let match = /at\s+(.+?)\s+line\s+(\d+)/i.exec(violation);

    if(match){
        if(match[1] == filePath){
            return +match[2] - 1;
        } else {
            // The error/warnings must be in an imported library (possibly indirectly imported).
            let importLine = 0; // If indirectly imported
            const importFileName = match[1].replace('.pm', '').replace(/[\\\/]/g, "::");
            perlDoc.imported.forEach((line, mod) => {
                // importFileName could be something like usr::lib::perl::dir::Foo::Bar
                if (importFileName.endsWith(mod)){
                    importLine = line;
                }
            })
            return importLine; 
        }
    }
    
    match = /\s+is not exported by the ([\w:]+) module$/i.exec(violation);
    if(match){
        let importLine = perlDoc.imported.get(match[1])
        if(typeof importLine != 'undefined'){
            return importLine;
        } else {
            return 0;
        }
    }
    return;
}




export async function perlcritic(textDocument: TextDocument, workspaceFolders: WorkspaceFolder[] | null, settings: NavigatorSettings): Promise<Diagnostic[]> {
    if(!settings.perlcriticEnabled) return []; 
    const critic_path = join(getPerlAssetsPath(), 'criticWrapper.pl');
    let criticParams: string[] = [critic_path].concat(getCriticProfile(workspaceFolders, settings));
    criticParams = criticParams.concat(['--file', Uri.parse(textDocument.uri).fsPath]);

    nLog("Now starting perlcritic with: " + criticParams.join(" "), settings);
    const code = textDocument.getText();
    const diagnostics: Diagnostic[] = [];
    let output: string;
    try {
        const process = async_execFile(settings.perlPath, criticParams, {timeout: 25000});
        process?.child?.stdin?.on('error', (error: any) => {
            nLog("Perl Critic Error Caught: ", settings);
            nLog(error, settings);
        });
        process?.child?.stdin?.write(code);
        process?.child?.stdin?.end();
        const out = await process;
        output = out.stdout;
    } catch(error: any) {
        nLog("Perlcritic failed with unknown error", settings);
        nLog(error, settings);
        return diagnostics;
    }

    nLog("Critic output: " + output, settings);
    output.split("\n").forEach(violation => {
        maybeAddCriticDiag(violation, diagnostics, settings);
    });

    return diagnostics;
}

function getCriticProfile (workspaceFolders: WorkspaceFolder[] | null, settings: NavigatorSettings): string[] {
    let profileCmd: string[] = [];
    if (settings.perlcriticProfile) {
        let profile = settings.perlcriticProfile;
        if (/\$workspaceFolder/.test(profile)){
            if (workspaceFolders){
                // TODO: Fix this too. Only uses the first workspace folder
                const workspaceUri = Uri.parse(workspaceFolders[0].uri).fsPath;
                profileCmd.push('--profile');
                profileCmd.push(profile.replace(/\$workspaceFolder/g, workspaceUri));
            } else {
                nLog("You specified $workspaceFolder in your perlcritic path, but didn't include any workspace folders. Ignoring profile.", settings);
            }
        } else {
            profileCmd.push('--profile');
            profileCmd.push(profile);
        }
    }
    return profileCmd;
}

function maybeAddCriticDiag(violation: string, diagnostics: Diagnostic[], settings: NavigatorSettings): void {

    // Severity ~|~ Line ~|~ Column ~|~ Description ~|~ Policy ~||~ Newline
    const tokens = violation.replace("~||~", "").replace(/\r/g, "").split("~|~");
    if(tokens.length != 5){
        return;
    }
    const line_num = +tokens[1] - 1;
    const col_num  = +tokens[2] - 1;
    const message = tokens[3] + " (" + tokens[4] + ", Severity: " + tokens[0] + ")";
    const severity = getCriticDiagnosticSeverity(tokens[0], settings);
    if(!severity){
        return;
    }
    diagnostics.push({
        severity: severity,
        range: {
            start: { line: line_num, character: col_num },
            end: { line: line_num, character: col_num+500 } // Arbitrarily large
        },
        message: "Critic: " + message,
        source: 'perlnavigator'
    });
}

function getCriticDiagnosticSeverity(severity_num: string, settings: NavigatorSettings): DiagnosticSeverity | undefined {
    
    // Unknown severity gets max (should never happen)
    const severity_config = severity_num == '1' ? settings.severity1 :
                            severity_num == '2' ? settings.severity2 :
                            severity_num == '3' ? settings.severity3 :
                            severity_num == '4' ? settings.severity4 :
                                                  settings.severity5 ; 

    switch (severity_config) {
        case "none":
            return undefined;
        case "hint":
            return DiagnosticSeverity.Hint;
        case "info":
            return DiagnosticSeverity.Information;
        case "warning":
            return DiagnosticSeverity.Warning;
        default:
            return DiagnosticSeverity.Error;
    }
}
