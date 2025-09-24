# PM2 Web Manager

![PM2 Web Manager Screenshot](https://i.imgur.com/yL9TMCh.png)

A modern, lightweight, and self-hosted web UI for managing your PM2 processes. Built with Node.js and Express, with no heavy dependencies. It offers a simple and fast alternative to more complex solutions.

## Key Features

- **Lightweight & Fast:** Single-page interface built with Tailwind CSS, with no heavy frameworks.
- **Secure by Design:** User/password authentication and secure session management.
- **Full Process Management:** Start, restart, stop, and delete PM2 processes with a single click.
- **Integrated File Browser:** Visually navigate your server's directories and select scripts to run.
- **Real-time Log Viewer:** Access `stdout` and `stderr` logs directly from the UI.
- **Global Actions:** Stop or restart all processes at once.
- **Zero Configuration:** No external database required. All settings are managed through a simple `.env` file.
- **Self-Hosted:** You have full control over your instance.

## Installation

Prerequisites: **Node.js** (v16 or higher) and **PM2** installed globally.

1.  **Clone the repository:**
    ```bash
    git clone [https://github.com/your-username/pm2-web-manager.git](https://github.com/your-username/pm2-web-manager.git)
    cd pm2-web-manager
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Set up your credentials:**
    Create a `.env` file from the example:
    ```bash
    cp .env.example .env
    ```
    Now, edit the `.env` file and define your own credentials and settings:
    ```ini
    # Server port
    PORT=4747

    # Base directory for the file browser
    PM2_BASE_DIR="/home/your_user/projects"

    # Access credentials
    ADMIN_USER="admin"
    ADMIN_PASSWORD="use_a_very_strong_password_here"

    # Secret key for sessions (use a long, random string)
    SESSION_SECRET="change_this_secret_key_to_something_long"
    ```

4.  **Start the application with PM2:**
    The recommended way to run the manager is by using the provided `ecosystem.config.js` file:
    ```bash
    pm2 start ecosystem.config.js
    ```

5.  **Save the process for automatic restarts:**
    ```bash
    pm2 save
    ```

You're all set! You can now access the web interface at `http://your-server-ip:4747` and log in with the credentials you configured.

## Contributing

Contributions are welcome. If you have an idea to improve the tool or find a bug, please open an issue or submit a pull request.

## License

This project is licensed under the MIT License.