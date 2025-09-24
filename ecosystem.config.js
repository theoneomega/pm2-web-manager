module.exports = {
    apps: [{
        name: 'pm2-manager',
        script: 'server.js',
        env: {
            NODE_ENV: 'production',
        },
        max_memory_restart: '200M',
        watch: false,
        autorestart: true
    }]
};
