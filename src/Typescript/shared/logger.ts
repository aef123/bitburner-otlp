import { NS } from "../../../NetScriptDefinitions";

/**
 * Minimal logging interface + levels shared by every script. OtlpLogger (in
 * shared/otlpTelemetry.ts) implements ILogger, so anything written against this
 * interface can ship its logs to an OpenTelemetry collector without changes.
 */

export enum LogLevel {
    ERROR = 0,
    WARNING = 1,
    INFO = 2,
    VERBOSE = 3,
    DEBUG = 4,
    GLOBAL = 100
}

export interface ILogger {
    log(message: string, level: LogLevel): boolean;
}

/** Swallows everything. Useful as a default when a caller passes no logger. */
export class NullLogger implements ILogger
{
    log(message: string, level: LogLevel = LogLevel.INFO): boolean
    {
        return true;
    }
}

/**
 * Plain in-game logger: writes to the script's own log (tail), and to the
 * terminal for WARNING/ERROR (or everything, with logToTerminal = true).
 */
export class Logger implements ILogger {
    private ns: NS;
    private level: LogLevel;
    private logToTerminal: boolean;

    constructor(ns: NS, level: LogLevel = LogLevel.ERROR, logToTerminal: boolean = false) {
        this.ns = ns;
        this.level = level;
        this.logToTerminal = logToTerminal;
    }

    set logLevel(level: LogLevel) {
        this.level = level;
    }

    log(message: string, level: LogLevel = LogLevel.INFO): boolean
    {
        if (level === LogLevel.GLOBAL || level <= this.level)
        {
            const m: string = level === LogLevel.GLOBAL ? message : `[${this.levelName(level)}] ${message}`;
            this.ns.print(m);

            if (this.logToTerminal || level <= LogLevel.WARNING){
                this.ns.tprint(m);
            }
            return true;
        } else {
            return false;
        }
    }

    private levelName(level: LogLevel): string {
        switch (level){
            case LogLevel.ERROR:
                return "ERROR";
            case LogLevel.WARNING:
                return "WARNING";
            case LogLevel.INFO:
                return "INFO";
            case LogLevel.VERBOSE:
                return "VERBOSE";
            case LogLevel.DEBUG:
                return "DEBUG";
            case LogLevel.GLOBAL:
                return "GLOBAL";
            default:
                return "UNKNOWN";
        }
    }
}
