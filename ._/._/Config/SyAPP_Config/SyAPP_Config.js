import SyAPP from '../../../SyAPP.js'
import SyDB from '../../../SyDB.js'

class SyAPP_Config extends SyAPP.Func() {
    constructor(){
        super(
            'syapp',
            async (props) => {
                let uid = props.session.UniqueID
                
                // Store entry point
                if (!this.Storages.Has(uid, 'syapp_entry_func')) {
                    const previousFunc = props.session.PreviousPath
                    if (previousFunc && 
                        previousFunc !== 'syapp' && 
                        previousFunc !== 'error' && 
                        previousFunc !== 'notfounded') {
                        this.Storages.Set(uid, 'syapp_entry_func', previousFunc)
                    } else {
                        this.Storages.Set(uid, 'syapp_entry_func', 'config')
                    }
                }
                
                const returnFunc = this.Storages.Get(uid, 'syapp_entry_func') || 'config'
                const isAdmin = this.Admin.IsAdmin(uid)
                
                // Handle refresh mode toggle
                if (props.toggleRefresh && isAdmin) {
                    if (this._syappInstance) {
                        if (this._syappInstance.Refresher) {
                            clearInterval(this._syappInstance.Refresher)
                            this._syappInstance.Refresher = null
                        } else {
                            const interval = this._syappInstance._refreshInterval || 500
                            this._syappInstance.Refresher = setInterval(async () => {  
                                let sessions = [...this._syappInstance.Sessions.keys()]
                                sessions.forEach(k => {
                                    if (this._syappInstance.Sessions.get(k).ActualProps.page) {
                                        this._syappInstance.LoadScreen(this._syappInstance.Sessions.get(k).ActualPath, {
                                            props: {
                                                page: this._syappInstance.Sessions.get(k).ActualProps.page,
                                                _isRefresh: true
                                            }
                                        })
                                    } else {
                                        this._syappInstance.LoadScreen(this._syappInstance.Sessions.get(k).ActualPath, {
                                            props: { _isRefresh: true }
                                        })
                                    }
                                })
                            }, interval)
                        }
                    }
                }
                
                // ─── Dashboard ───
                this.Page(uid, '', async () => {
                    this.Text(uid, this.TextColor.brightCyan('SyAPP Admin Dashboard'))
                    this.Text(uid, '')
                    
                    if (!isAdmin) {
                        this.Text(uid, this.TextColor.brightRed('Access Denied'))
                        this.Text(uid, 'You do not have admin privileges.')
                        this.Text(uid, '')
                        this.Button(uid, {
                            name: `← Return to ${returnFunc}`,
                            path: returnFunc,
                            resetSelection: true
                        })
                        return
                    }
                    
                    const config = this.Admin.GetConfig(uid)
                    if (config) {
                        this.Text(uid, this.TextColor.brightGreen('Server Configuration'))
                        this.Text(uid, `Main Function: ${config.mainFuncName}`)
                        this.Text(uid, `HTTP Server: ${config.httpEnabled ? this.TextColor.green('Enabled') : this.TextColor.red('Disabled')}`)
                        if (config.httpEnabled) {
                            this.Text(uid, `URL: http://${config.httpHost}:${config.httpPort}`)
                            this.Text(uid, `Base Route: ${config.baseRoute ? 'Yes' : 'No'}`)
                        }
                        this.Text(uid, `Functions: ${config.functionsCount}`)
                        this.Text(uid, `Sessions: ${config.sessionsCount}`)
                        this.Text(uid, `Admins: ${config.adminCount}`)
                        
                        const hasRefresher = this._syappInstance && this._syappInstance.Refresher
                        this.Text(uid, `Refresh Mode: ${hasRefresher ? this.TextColor.green('Active') : this.TextColor.red('Inactive')} (${config.refreshInterval}ms)`)
                        this.Text(uid, `Last Updated: ${new Date(config.timestamp).toLocaleString()}`)
                        this.Text(uid, '')
                        
                        this.Button(uid, {
                            name: `Refresh Mode: ${hasRefresher ? this.TextColor.green('ON') : this.TextColor.red('OFF')}`,
                            path: 'syapp',
                            props: { page: '', toggleRefresh: true }
                        })
                        
                        this.Text(uid, '')
                    }
                    
                    this.Button(uid, {
                        name: this.TextColor.brightYellow('Active Sessions'),
                        path: 'syapp',
                        props: { page: 'sessions' }
                    })
                    
                    this.Button(uid, {
                        name: this.TextColor.brightMagenta('Manage Admins'),
                        path: 'syapp',
                        props: { page: 'admins' }
                    })
                    
                    this.Button(uid, {
                        name: this.TextColor.brightCyan('Server Settings'),
                        path: 'syapp',
                        props: { page: 'settings' }
                    })
                    
                    this.Button(uid, {
                        name: this.TextColor.brightBlue('Server Statistics'),
                        path: 'syapp',
                        props: { page: 'stats' }
                    })
                    
                    this.Text(uid, '')
                    
                    this.Button(uid, {
                        name: `← Return to ${returnFunc}`,
                        path: returnFunc,
                        resetSelection: true
                    })
                })
                
                // ─── Sessions ───
                this.Page(uid, 'sessions', async () => {
                    this.Text(uid, this.TextColor.brightYellow('Active Sessions'))
                    this.Text(uid, '')
                    
                    const sessions = this.Admin.GetSessions(uid)
                    if (sessions && sessions.length > 0) {
                        sessions.forEach((session, index) => {
                            const statusColor = session.inAction ? this.TextColor.green : this.TextColor.dim
                            this.Text(uid, statusColor(`${index + 1}. ${session.id.substring(0, 20)}...`))
                            this.Text(uid, `Path: ${session.currentPath || 'N/A'}`)
                            this.Text(uid, `Page: ${session.currentPage || 'N/A'}`)
                            this.Text(uid, `Status: ${session.inAction ? 'Active' : 'Idle'}`)
                            this.Text(uid, `Admin: ${session.isAdmin ? 'Yes' : 'No'}`)
                            this.Text(uid, '')
                        })
                    } else {
                        this.Text(uid, this.TextColor.dim('No active sessions found.'))
                        this.Text(uid, '')
                    }
                    
                    this.Button(uid, {
                        name: '↻ Refresh',
                        path: 'syapp',
                        props: { page: 'sessions' }
                    })
                    
                    this.Button(uid, {
                        name: '← Back to Dashboard',
                        path: 'syapp',
                        props: { page: '' }
                    })
                    
                    this.Text(uid, '')
                })
                
                // ─── Admins ───
                this.Page(uid, 'admins', async () => {
                    this.Text(uid, this.TextColor.brightMagenta('Admin Management'))
                    this.Text(uid, '')
                    
                    const config = this.Admin.GetConfig(uid)
                    if (config) {
                        this.Text(uid, `Current Admin Count: ${this.TextColor.brightWhite(config.adminCount)}`)
                        this.Text(uid, '')
                        
                        const sessions = this.Admin.GetSessions(uid)
                        const adminSessions = sessions ? sessions.filter(s => s.isAdmin) : []
                        
                        if (adminSessions.length > 0) {
                            this.Text(uid, this.TextColor.underline('Current Admins:'))
                            adminSessions.forEach((session, index) => {
                                this.Text(uid, `${index + 1}. ${session.id}`)
                            })
                        }
                        this.Text(uid, '')
                    }
                    
                    this.Button(uid, {
                        name: this.TextColor.green('+ Add Admin (by session ID)'),
                        path: 'syapp',
                        props: { page: 'admins', addadmin: true }
                    })
                    
                    this.Button(uid, {
                        name: this.TextColor.red('- Remove Admin (by session ID)'),
                        path: 'syapp',
                        props: { page: 'admins', removeadmin: true }
                    })
                    
                    if (props.addadmin && props.inputValue) {
                        const result = this.Admin.AddAdmin(uid, props.inputValue)
                        this.Text(uid, result.success ? 
                            this.TextColor.green(`✓ ${result.message}`) : 
                            this.TextColor.red(`✗ ${result.error}`))
                    }
                    
                    if (props.removeadmin && props.inputValue) {
                        const result = this.Admin.RemoveAdmin(uid, props.inputValue)
                        this.Text(uid, result.success ? 
                            this.TextColor.green(`✓ ${result.message}`) : 
                            this.TextColor.red(`✗ ${result.error}`))
                    }
                    
                    if ((props.addadmin || props.removeadmin) && !props.inputValue) {
                        this.WaitInput(uid, {
                            question: props.addadmin ? 'Enter session ID to add as admin:' : 'Enter session ID to remove from admin:',
                            path: 'syapp',
                            props: { 
                                page: 'admins',
                                addadmin: props.addadmin,
                                removeadmin: props.removeadmin
                            }
                        })
                    }
                    
                    this.Text(uid, '')
                    
                    this.Button(uid, {
                        name: '← Back to Dashboard',
                        path: 'syapp',
                        props: { page: '' }
                    })
                })
                
                // ─── Settings ───
                this.Page(uid, 'settings', async () => {
                    this.Text(uid, this.TextColor.brightCyan('Server Settings'))
                    this.Text(uid, '')
                    
                    const httpConfig = this.Admin.GetHTTPConfig(uid)
                    if (httpConfig) {
                        this.Text(uid, this.TextColor.underline('HTTP Configuration:'))
                        this.Text(uid, `Enabled: ${httpConfig.enabled ? 'Yes' : 'No'}`)
                        this.Text(uid, `Port: ${httpConfig.port}`)
                        this.Text(uid, `Host: ${httpConfig.host}`)
                        this.Text(uid, `Base Route: ${httpConfig.baseRoute ? 'Yes' : 'No'}`)
                        this.Text(uid, `Include Func Name: ${httpConfig.includeFuncName ? 'Yes' : 'No'}`)
                        this.Text(uid, `Total Routes: ${httpConfig.routesCount}`)
                        this.Text(uid, '')
                    }
                    
                    this.Text(uid, this.TextColor.dim('Settings changes require admin privileges'))
                    this.Text(uid, this.TextColor.dim('Some changes may require server restart'))
                    this.Text(uid, '')
                    
                    this.Button(uid, {
                        name: `Base Route: ${this.Admin.GetConfig(uid)?.baseRoute ? this.TextColor.green('ON') : this.TextColor.red('OFF')}`,
                        path: 'syapp',
                        props: { page: 'settings', toggleBaseRoute: true }
                    })
                    
                    this.Button(uid, {
                        name: `Include Func Name: ${this.Admin.GetHTTPConfig(uid)?.includeFuncName ? this.TextColor.green('ON') : this.TextColor.red('OFF')}`,
                        path: 'syapp',
                        props: { page: 'settings', toggleFuncName: true }
                    })
                    
                    if (props.toggleBaseRoute) {
                        const currentBaseRoute = this.Admin.GetConfig(uid)?.baseRoute
                        const result = this.Admin.UpdateConfig(uid, { baseRoute: !currentBaseRoute })
                        this.Text(uid, result.success ? 
                            this.TextColor.green('✓ Base route toggled') : 
                            this.TextColor.red('✗ Failed to toggle base route'))
                    }
                    
                    if (props.toggleFuncName) {
                        const httpConfig = this.Admin.GetHTTPConfig(uid)
                        const result = this.Admin.UpdateConfig(uid, { includeFuncName: !httpConfig?.includeFuncName })
                        this.Text(uid, result.success ? 
                            this.TextColor.green('✓ Include func name toggled') : 
                            this.TextColor.red('✗ Failed to toggle include func name'))
                    }
                    
                    this.Text(uid, '')
                    
                    this.Button(uid, {
                        name: '← Back to Dashboard',
                        path: 'syapp',
                        props: { page: '' }
                    })
                })
                
                // ─── Statistics ───
                this.Page(uid, 'stats', async () => {
                    this.Text(uid, this.TextColor.brightBlue('Server Statistics'))
                    this.Text(uid, '')
                    
                    const stats = this.Admin.GetStats(uid)
                    if (stats) {
                        this.Text(uid, this.TextColor.underline('Memory Usage:'))
                        this.Text(uid, `Heap Used: ${stats.memory.heapUsed} MB`)
                        this.Text(uid, `Heap Total: ${stats.memory.heapTotal} MB`)
                        this.Text(uid, `External: ${stats.memory.external} MB`)
                        this.Text(uid, '')
                        
                        this.Text(uid, this.TextColor.underline('Performance:'))
                        this.Text(uid, `Uptime: ${Math.floor(stats.uptime / 60)} minutes`)
                        this.Text(uid, `Active Sessions: ${stats.sessions.active}/${stats.sessions.total}`)
                        this.Text(uid, '')
                        
                        this.Text(uid, this.TextColor.underline('Functions:'))
                        this.Text(uid, `Total: ${stats.functions.total}`)
                        if (stats.functions.list) {
                            this.Text(uid, `List: ${stats.functions.list.slice(0, 5).join(', ')}${stats.functions.list.length > 5 ? '...' : ''}`)
                        }
                        this.Text(uid, '')
                        
                        if (stats.http) {
                            this.Text(uid, this.TextColor.underline('HTTP Routes:'))
                            this.Text(uid, `Total: ${stats.http.total}`)
                            this.Text(uid, `GET: ${stats.http.byMethod.GET}`)
                            this.Text(uid, `POST: ${stats.http.byMethod.POST}`)
                            this.Text(uid, `PUT: ${stats.http.byMethod.PUT}`)
                            this.Text(uid, `DELETE: ${stats.http.byMethod.DELETE}`)
                            this.Text(uid, `With Models: ${stats.http.withModels}`)
                            this.Text(uid, `With Validation: ${stats.http.withValidation}`)
                            this.Text(uid, '')
                        }
                    }
                    
                    this.Button(uid, {
                        name: '↻ Refresh Stats',
                        path: 'syapp',
                        props: { page: 'stats' }
                    })
                    
                    this.Button(uid, {
                        name: '← Back to Dashboard',
                        path: 'syapp',
                        props: { page: '' }
                    })
                    
                    this.Text(uid, '')
                })
            },
            {linked : []}
        )
    }
}

export default SyAPP_Config