// Get all UFID digit inputs
const ufidInputs = document.querySelectorAll('.ufid-digit');
const signInBtn = document.getElementById('signInBtn');
const signOutBtn = document.getElementById('signOutBtn');
const statusMessage = document.getElementById('statusMessage');
const adminLink = document.getElementById('adminLink');
const themeToggle = document.getElementById('themeToggle');

// ==================== DARK MODE ====================

/**
 * Initialize theme based on localStorage or system preference
 */
function initTheme() {
    const savedTheme = localStorage.getItem('theme');
    const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

    if (savedTheme) {
        document.documentElement.setAttribute('data-theme', savedTheme);
    } else if (systemPrefersDark) {
        document.documentElement.setAttribute('data-theme', 'dark');
    }

    updateThemeIcon();
}

/**
 * Toggle between light and dark themes
 */
function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    updateThemeIcon();
}

/**
 * Update the theme toggle button icon
 */
function updateThemeIcon() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const icon = themeToggle.querySelector('i');

    if (icon) {
        icon.className = isDark ? 'fas fa-sun' : 'fas fa-moon';
    }
    themeToggle.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
}

// Listen for system theme changes
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!localStorage.getItem('theme')) {
        document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
        updateThemeIcon();
    }
});

// Theme toggle click handler
themeToggle.addEventListener('click', toggleTheme);

// Initialize theme on load
initTheme();

// Setup UFID input handling
setupUfidInputs();

function setupUfidInputs() {
    ufidInputs.forEach((input, index) => {
        // Only allow numbers
        input.addEventListener('input', function (e) {
            const value = e.target.value.replace(/\D/g, '');
            e.target.value = value;

            if (value) {
                e.target.classList.add('filled');
                // Auto-focus next input
                if (index < ufidInputs.length - 1) {
                    ufidInputs[index + 1].focus();
                }
            } else {
                e.target.classList.remove('filled');
            }

            validateUfid();
        });

        // Handle backspace
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Backspace' && !e.target.value && index > 0) {
                ufidInputs[index - 1].focus();
            }

            if (e.key === 'Enter' && isUfidComplete()) {
                signInBtn.click();
            }
        });

        // Handle paste
        input.addEventListener('paste', function (e) {
            e.preventDefault();
            const paste = (e.clipboardData || window.clipboardData).getData('text');
            const numbers = paste.replace(/\D/g, '').slice(0, 8);

            numbers.split('').forEach((digit, i) => {
                if (ufidInputs[i]) {
                    ufidInputs[i].value = digit;
                    ufidInputs[i].classList.add('filled');
                }
            });

            validateUfid();
        });
    });
}

function getUfidValue() {
    return Array.from(ufidInputs).map(input => input.value).join('');
}

function isUfidComplete() {
    return getUfidValue().length === 8;
}

function clearUfid() {
    ufidInputs.forEach(input => {
        input.value = '';
        input.classList.remove('filled', 'error');
    });
    ufidInputs[0].focus();
}

function validateUfid() {
    const ufid = getUfidValue();
    const isComplete = ufid.length === 8;

    signInBtn.disabled = !isComplete;
    signOutBtn.disabled = !isComplete;

    // Remove error state when user starts typing again
    ufidInputs.forEach(input => {
        input.classList.remove('error');
    });
}

function showUfidError() {
    ufidInputs.forEach(input => {
        if (input.value) {
            input.classList.add('error');
        }
    });
}

// Sign in functionality
signInBtn.addEventListener('click', async () => {
    const ufid = getUfidValue();

    if (!isUfidComplete()) {
        showStatus('Please enter a complete 8-digit UF ID', 'error');
        showUfidError();
        return;
    }

    try {
        signInBtn.disabled = true;
        signInBtn.classList.add('loading');

        const result = await window.electronAPI.signIn({ ufid, name: '' });

        if (result.success) {
            showStatus(`Welcome ${result.studentName}! You have signed in successfully.`, 'success');
            clearUfid();
        } else {
            showStatus(result.message || 'Sign in failed', 'error');
            if (result.unauthorized) {
                showUfidError();
            }
        }
    } catch (error) {
        showStatus('Error: ' + error.message, 'error');
        showUfidError();
    } finally {
        signInBtn.disabled = false;
        signInBtn.classList.remove('loading');
        validateUfid();
    }
});

// Sign out functionality
signOutBtn.addEventListener('click', async () => {
    const ufid = getUfidValue();

    if (!isUfidComplete()) {
        showStatus('Please enter a complete 8-digit UF ID', 'error');
        showUfidError();
        return;
    }

    try {
        signOutBtn.disabled = true;
        signOutBtn.classList.add('loading');

        const result = await window.electronAPI.signOut({ ufid, name: '' });

        if (result.success) {
            showStatus(`Goodbye ${result.studentName}! You have signed out successfully.`, 'success');
            clearUfid();
        } else {
            showStatus(result.message || 'Sign out failed', 'error');
            if (result.unauthorized) {
                showUfidError();
            }
        }
    } catch (error) {
        showStatus('Error: ' + error.message, 'error');
        showUfidError();
    } finally {
        signOutBtn.disabled = false;
        signOutBtn.classList.remove('loading');
        validateUfid();
    }
});

// Admin access functionality
adminLink.addEventListener('click', (e) => {
    e.preventDefault();
    showAdminModal();
});

function showAdminModal() {
    const modal = document.createElement('div');
    modal.className = 'admin-modal';
    modal.innerHTML = `
        <div class="admin-modal-content">
            <div class="admin-modal-header">
                <h3>Admin Access</h3>
                <button class="admin-modal-close" id="adminModalClose">×</button>
            </div>
            <div class="admin-modal-body">
                <label for="adminPassword">Enter admin password:</label>
                <input type="password" id="adminPassword" class="admin-password-input" placeholder="Password">
                <div id="adminError" class="admin-error"></div>
            </div>
            <div class="admin-modal-footer">
                <button class="admin-cancel-btn" id="adminCancelBtn">Cancel</button>
                <button class="admin-login-btn" id="adminLoginBtn">Login</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // Add event listeners
    const closeBtn = document.getElementById('adminModalClose');
    const cancelBtn = document.getElementById('adminCancelBtn');
    const loginBtn = document.getElementById('adminLoginBtn');
    const passwordInput = document.getElementById('adminPassword');

    closeBtn.addEventListener('click', closeAdminModal);
    cancelBtn.addEventListener('click', closeAdminModal);
    loginBtn.addEventListener('click', verifyAdminPassword);

    // Handle Enter key
    passwordInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            verifyAdminPassword();
        }
    });

    // Close modal when clicking outside
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeAdminModal();
        }
    });

    // Focus on password input
    setTimeout(() => {
        passwordInput.focus();
    }, 100);
}

function closeAdminModal() {
    const modal = document.querySelector('.admin-modal');
    if (modal) {
        modal.remove();
    }
}

async function verifyAdminPassword() {
    const passwordInput = document.getElementById('adminPassword');
    const errorDiv = document.getElementById('adminError');
    const loginBtn = document.getElementById('adminLoginBtn');
    const password = passwordInput.value.trim();

    if (!password) {
        showAdminError('Please enter a password');
        return;
    }

    try {
        loginBtn.disabled = true;
        loginBtn.textContent = 'Verifying...';

        const result = await window.electronAPI.verifyAdmin(password);

        if (result && result.success) {
            closeAdminModal();
            window.location.href = 'admin.html';
        } else {
            showAdminError('Invalid admin password');
        }
    } catch (error) {
        console.error('Admin verification error:', error);
        showAdminError('Error verifying password. Please try again.');
    } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = 'Login';
    }
}

function showAdminError(message) {
    const errorDiv = document.getElementById('adminError');
    if (errorDiv) {
        errorDiv.textContent = message;
        errorDiv.style.display = 'block';

        setTimeout(() => {
            errorDiv.style.display = 'none';
        }, 3000);
    }
}

// Status message functionality
function showStatus(message, type) {
    const icon = type === 'success'
        ? '<i class="fas fa-check-circle"></i>'
        : '<i class="fas fa-exclamation-circle"></i>';

    statusMessage.innerHTML = `${icon} ${message}`;
    statusMessage.className = `status-message ${type} show`;

    // Auto-hide after 5 seconds
    setTimeout(() => {
        statusMessage.classList.remove('show');
        setTimeout(() => {
            statusMessage.className = 'status-message';
        }, 300);
    }, 5000);
}

// Initialize the interface
document.addEventListener('DOMContentLoaded', () => {
    // Focus on first input
    ufidInputs[0].focus();

    // Initial validation
    validateUfid();

    console.log('UF Lab Attendance System initialized');
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    // Escape key to clear inputs
    if (e.key === 'Escape') {
        clearUfid();
    }

    // Ctrl/Cmd + R to clear and refresh (prevent default refresh)
    if ((e.ctrlKey || e.metaKey) && e.key === 'r') {
        e.preventDefault();
        clearUfid();
    }
});

// Auto-clear inputs after successful action (optional)
function scheduleAutoClear() {
    setTimeout(() => {
        if (statusMessage.style.display === 'none') {
            clearUfid();
        }
    }, 10000); // Clear after 10 seconds if no status message
}

// Additional helper functions
function focusFirstEmptyInput() {
    for (let i = 0; i < ufidInputs.length; i++) {
        if (!ufidInputs[i].value) {
            ufidInputs[i].focus();
            break;
        }
    }
}

// Handle window focus - focus on first empty input
window.addEventListener('focus', () => {
    if (!isUfidComplete()) {
        focusFirstEmptyInput();
    }
});