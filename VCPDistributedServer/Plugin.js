// Plugin.js for VCP Distributed Server
const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const schedule = require('node-schedule');
const dotenv = require('dotenv');

const PLUGIN_DIR = path.join(__dirname, 'Plugin');
const manifestFileName = 'plugin-manifest.json';

class PluginManager {
    constructor() {
        this.plugins = new Map();
        this.serviceModules = new Map(); // 新增：用于存储服务类插件
        this.projectBasePath = null;
        this.debugMode = (process.env.DebugMode || "False").toLowerCase() === "true";
    }

    setProjectBasePath(basePath) {
        this.projectBasePath = basePath;
        if (this.debugMode) console.log(`[DistPluginManager] Project base path set to: ${this.projectBasePath}`);
    }

    _getPluginConfig(pluginManifest) {
        const config = {};
        const globalEnv = process.env;
        const pluginSpecificEnv = pluginManifest.pluginSpecificEnvConfig || {};

        if (pluginManifest.configSchema) {
            for (const key in pluginManifest.configSchema) {
                const expectedType = pluginManifest.configSchema[key];
                let rawValue;

                if (pluginSpecificEnv.hasOwnProperty(key)) {
                    rawValue = pluginSpecificEnv[key];
                } else if (globalEnv.hasOwnProperty(key)) {
                    rawValue = globalEnv[key];
                } else {
                    continue;
                }

                let value = rawValue;
                if (expectedType === 'integer') {
                    value = parseInt(value, 10);
                    if (isNaN(value)) value = undefined;
                } else if (expectedType === 'boolean') {
                    value = String(value).toLowerCase() === 'true';
                }
                config[key] = value;
            }
        }
        return config;
    }

    async loadPlugins() {
        console.log('[DistPluginManager] Starting plugin discovery...');
        this.plugins.clear();

        try {
            const pluginFolders = await fs.readdir(PLUGIN_DIR, { withFileTypes: true });
            for (const folder of pluginFolders) {
                if (folder.isDirectory()) {
                    const pluginPath = path.join(PLUGIN_DIR, folder.name);
                    const manifestPath = path.join(pluginPath, manifestFileName);
                    try {
                        const manifestContent = await fs.readFile(manifestPath, 'utf-8');
                        const manifest = JSON.parse(manifestContent);
                        if (!manifest.name || !manifest.pluginType || !manifest.entryPoint) {
                            if (this.debugMode) console.warn(`[DistPluginManager] Invalid manifest in ${folder.name}. Skipping.`);
                            continue;
                        }
                        if (this.plugins.has(manifest.name)) {
                            if (this.debugMode) console.warn(`[DistPluginManager] Duplicate plugin name '${manifest.name}'. Skipping.`);
                            continue;
                        }
                        manifest.basePath = pluginPath;
                        
                        // Load plugin-specific config.env
                        manifest.pluginSpecificEnvConfig = {};
                         try {
                            await fs.access(path.join(pluginPath, 'config.env'));
                            const pluginEnvContent = await fs.readFile(path.join(pluginPath, 'config.env'), 'utf-8');
                            manifest.pluginSpecificEnvConfig = dotenv.parse(pluginEnvContent);
                        } catch (envError) {
                            // Ignore if config.env doesn't exist
                        }

                        // 加载所有类型的插件
                        this.plugins.set(manifest.name, manifest);
                        console.log(`[DistPluginManager] Loaded manifest: ${manifest.displayName} (${manifest.name}, Type: ${manifest.pluginType})`);

                        // 如果是服务类插件，则加载其模块以备初始化
                        if (manifest.pluginType === 'service' && manifest.entryPoint.script && manifest.communication?.protocol === 'direct') {
                            try {
                                const scriptPath = path.join(pluginPath, manifest.entryPoint.script);
                                const serviceModule = require(scriptPath);
                                this.serviceModules.set(manifest.name, { manifest, module: serviceModule });
                                if (this.debugMode) console.log(`[DistPluginManager] Loaded service module: ${manifest.name}`);
                            } catch (e) {
                                console.error(`[DistPluginManager] Error requiring service module for ${manifest.name}:`, e);
                            }
                        }
                    } catch (error) {
                        if (this.debugMode) console.error(`[DistPluginManager] Error loading plugin from ${folder.name}:`, error);
                    }
                }
            }
            console.log(`[DistPluginManager] Plugin discovery finished. Loaded ${this.plugins.size} plugins.`);
        } catch (error) {
            console.error(`[DistPluginManager] Plugin directory ${PLUGIN_DIR} not found or could not be read.`);
        }
    }
    
    getAllPluginManifests() {
        return Array.from(this.plugins.values());
    }

    getPlugin(name) {
        return this.plugins.get(name);
    }

    async processToolCall(toolName, toolArgs) {
        let executionParam = null;
        // Default behavior for all plugins: pass arguments as a JSON string.
        executionParam = toolArgs ? JSON.stringify(toolArgs) : null;

        if (this.debugMode) console.log(`[DistPluginManager] Calling executePlugin for: ${toolName} with prepared param:`, executionParam);
        
        // Now call the existing executePlugin with the correctly formatted parameter
        return this.executePlugin(toolName, executionParam);
    }

    async executePlugin(pluginName, inputData) {
        const plugin = this.plugins.get(pluginName);
        if (!plugin) {
            throw new Error(`[DistPluginManager] Plugin "${pluginName}" not found.`);
        }
        if (!plugin.entryPoint || !plugin.entryPoint.command) {
            throw new Error(`[DistPluginManager] Entry point command undefined for plugin "${pluginName}".`);
        }

        const pluginConfig = this._getPluginConfig(plugin);
        const envForProcess = { ...process.env, ...pluginConfig };
        if (this.projectBasePath) {
            envForProcess.PROJECT_BASE_PATH = this.projectBasePath;
        }
        envForProcess.PYTHONIOENCODING = 'utf-8';

        return new Promise((resolve, reject) => {
            const [command, ...args] = plugin.entryPoint.command.split(' ');
            const pluginProcess = spawn(command, args, { cwd: plugin.basePath, shell: true, env: envForProcess });

            let outputBuffer = '';
            let errorOutput = '';
            const timeoutDuration = plugin.communication?.timeout || 60000;

            const timeoutId = setTimeout(() => {
                pluginProcess.kill('SIGKILL');
                reject(new Error(`Plugin "${pluginName}" execution timed out.`));
            }, timeoutDuration);

            pluginProcess.stdout.setEncoding('utf8');
            pluginProcess.stdout.on('data', (data) => {
                outputBuffer += data;
            });

            pluginProcess.stderr.setEncoding('utf8');
            pluginProcess.stderr.on('data', (data) => {
                errorOutput += data;
            });

            pluginProcess.on('error', (err) => {
                clearTimeout(timeoutId);
                reject(new Error(`Failed to start plugin "${pluginName}": ${err.message}`));
            });

            pluginProcess.on('exit', (code) => {
                clearTimeout(timeoutId);
                if (code !== 0) {
                    const errMsg = `Plugin ${pluginName} exited with code ${code}. Stderr: ${errorOutput.trim()}`;
                    console.error(`[DistPluginManager] ${errMsg}`);
                    reject(new Error(errMsg));
                } else {
                    if (errorOutput.trim() && this.debugMode) {
                        console.warn(`[DistPluginManager] Plugin ${pluginName} produced stderr: ${errorOutput.trim()}`);
                    }
                    // The raw result from the plugin's stdout
                    resolve(outputBuffer.trim());
                }
            });

            if (inputData !== undefined && inputData !== null) {
                pluginProcess.stdin.write(inputData.toString());
            }
            pluginProcess.stdin.end();
        });
    }
    // 新增：初始化服务类插件的方法
    async initializeServices(app, adminApiRouter, projectBasePath) {
        if (!app) {
            console.error('[DistPluginManager] Cannot initialize services without Express app instance.');
            return;
        }
        console.log('[DistPluginManager] Initializing service plugins...');
        for (const [name, serviceData] of this.serviceModules) {
            try {
                const pluginConfig = this._getPluginConfig(serviceData.manifest);
                if (this.debugMode) console.log(`[DistPluginManager] Registering routes for service plugin: ${name}.`);
                
                if (serviceData.module && typeof serviceData.module.registerRoutes === 'function') {
                    // 分布式服务器只传递核心参数
                    serviceData.module.registerRoutes(app, pluginConfig, projectBasePath);
                }
            } catch (e) {
                console.error(`[DistPluginManager] Error initializing service plugin ${name}:`, e);
            }
        }
        console.log('[DistPluginManager] Service plugins initialized.');
    }
}

const pluginManager = new PluginManager();
module.exports = pluginManager;