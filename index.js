// DOM Elements - initialized after DOM ready
let ufidInputs;
let actionBtn;
let actionBtnText;
let actionBtnIcon;
let statusMessage;
let userHint;
let adminLink;
let clockElement;

// Track current mode and student status
let currentMode = 'signin'; // 'signin' or 'signout'
let currentStudent = null;
let checkStatusTimeout = null;

// ==================== INITIALIZATION ====================

document.addEventListener('DOMContentLoaded', () => {
    // Initialize DOM references
    ufidInputs = document.querySelectorAll('.ufid-digit');
    actionBtn = document.getElementById('actionBtn');
    actionBtnText = document.getElementById('actionBtnText');
    actionBtnIcon = actionBtn ? actionBtn.querySelector('.btn-content i') : null;
    statusMessage = document.getElementById('statusMessage');
    userHint = document.getElementById('userHint');
    adminLink = document.getElementById('adminLink');
    clockElement = document.getElementById('clock');

    // Start clock
    updateClock();
    setInterval(updateClock, 1000);

    // Setup UFID inputs
    setupUfidInputs();

    // Setup event listeners
    setupEventListeners();

    // Focus on first input
    if (ufidInputs && ufidInputs[0]) {
        ufidInputs[0].focus();
    }

    // Initial validation
    validateUfid();

    console.log('UF Lab Attendance System initialized');
});

// ==================== CLOCK ====================

function updateClock() {
    if (!clockElement) return;

    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    const displayMinutes = minutes.toString().padStart(2, '0');

    clockElement.textContent = `${displayHours}:${displayMinutes} ${ampm}`;
}

// ==================== EVENT LISTENERS ====================

function setupEventListeners() {
    // Action button click
    if (actionBtn) {
        actionBtn.addEventListener('click', handleActionClick);
    }

    // Admin link
    if (adminLink) {
        adminLink.addEventListener('click', (e) => {
            e.preventDefault();
            showAdminModal();
        });
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            clearUfid();
            if (statusMessage) {
                statusMessage.classList.remove('show');
            }
        }

        if ((e.ctrlKey || e.metaKey) && e.key === 'r') {
            e.preventDefault();
            clearUfid();
        }
    });

    // Window focus
    window.addEventListener('focus', () => {
        if (!isUfidComplete()) {
            focusFirstEmptyInput();
        }
    });
}

// ==================== UFID INPUT HANDLING ====================

function setupUfidInputs() {
    if (!ufidInputs) return;

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

            // Check student status when UFID is complete
            if (isUfidComplete()) {
                checkStudentStatus();
            } else {
                resetButtonState();
            }
        });

        // Handle backspace
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Backspace' && !e.target.value && index > 0) {
                ufidInputs[index - 1].focus();
            }

            if (e.key === 'Enter' && isUfidComplete() && actionBtn) {
                actionBtn.click();
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

            // Check student status when UFID is complete after paste
            if (isUfidComplete()) {
                checkStudentStatus();
            }
        });
    });
}

function getUfidValue() {
    if (!ufidInputs) return '';
    return Array.from(ufidInputs).map(input => input.value).join('');
}

function isUfidComplete() {
    return getUfidValue().length === 8;
}

function clearUfid() {
    if (!ufidInputs) return;

    ufidInputs.forEach(input => {
        input.value = '';
        input.classList.remove('filled', 'error');
    });
    ufidInputs[0].focus();
    resetButtonState();
}

function validateUfid() {
    const ufid = getUfidValue();
    const isComplete = ufid.length === 8;

    if (actionBtn) {
        actionBtn.disabled = !isComplete;
    }

    // Remove error state when user starts typing again
    if (ufidInputs) {
        ufidInputs.forEach(input => {
            input.classList.remove('error');
        });
    }
}

function showUfidError() {
    if (!ufidInputs) return;

    ufidInputs.forEach(input => {
        if (input.value) {
            input.classList.add('error');
        }
    });
}

function focusFirstEmptyInput() {
    if (!ufidInputs) return;

    for (let i = 0; i < ufidInputs.length; i++) {
        if (!ufidInputs[i].value) {
            ufidInputs[i].focus();
            break;
        }
    }
}

// ==================== BUTTON STATE MANAGEMENT ====================

function resetButtonState() {
    currentMode = 'signin';
    currentStudent = null;

    if (actionBtn) {
        actionBtn.classList.remove('signout-mode');
    }
    if (actionBtnText) {
        actionBtnText.textContent = 'Sign In';
    }
    if (actionBtnIcon) {
        actionBtnIcon.className = 'fas fa-arrow-right-to-bracket';
    }
    if (userHint) {
        userHint.textContent = '';
        userHint.className = 'user-hint';
    }
}

function setSignOutMode(studentName) {
    currentMode = 'signout';

    if (actionBtn) {
        actionBtn.classList.add('signout-mode');
    }
    if (actionBtnText) {
        actionBtnText.textContent = 'Sign Out';
    }
    if (actionBtnIcon) {
        actionBtnIcon.className = 'fas fa-arrow-right-from-bracket';
    }
    if (userHint) {
        userHint.innerHTML = `<i class="fas fa-user-check"></i> ${studentName} is currently signed in`;
        userHint.className = 'user-hint signed-in';
    }

    console.log('Button set to SIGN OUT mode for:', studentName);
}

function setSignInMode(studentName) {
    currentMode = 'signin';

    if (actionBtn) {
        actionBtn.classList.remove('signout-mode');
    }
    if (actionBtnText) {
        actionBtnText.textContent = 'Sign In';
    }
    if (actionBtnIcon) {
        actionBtnIcon.className = 'fas fa-arrow-right-to-bracket';
    }
    if (userHint && studentName) {
        userHint.innerHTML = `<i class="fas fa-user"></i> Welcome, ${studentName}`;
        userHint.className = 'user-hint active';
    }

    console.log('Button set to SIGN IN mode for:', studentName);
}

// ==================== STATUS CHECK ====================

async function checkStudentStatus() {
    const ufid = getUfidValue();

    if (!isUfidComplete()) {
        resetButtonState();
        return;
    }

    // Clear any pending check
    if (checkStatusTimeout) {
        clearTimeout(checkStatusTimeout);
    }

    // Debounce the status check
    checkStatusTimeout = setTimeout(async () => {
        try {
            if (userHint) {
                userHint.textContent = 'Checking...';
                userHint.className = 'user-hint active';
            }

            console.log('Checking status for UFID:', ufid);
            const result = await window.electronAPI.getStudentStatus(ufid);
            console.log('Status result:', result);

            if (result.authorized) {
                currentStudent = result;

                // Check if status indicates signed in (status is 'signin' when currently in lab)
                const isSignedIn = result.status === 'signin';
                console.log('Is signed in:', isSignedIn, 'Status:', result.status);

                if (isSignedIn) {
                    setSignOutMode(result.name);
                } else {
                    setSignInMode(result.name);
                }
            } else {
                // Student not found/not authorized
                resetButtonState();
                if (userHint) {
                    userHint.textContent = 'Student not found';
                    userHint.className = 'user-hint';
                }
            }
        } catch (error) {
            console.error('Error checking student status:', error);
            resetButtonState();
        }
    }, 200);
}

// ==================== ACTION HANDLER ====================

async function handleActionClick() {
    const ufid = getUfidValue();

    if (!isUfidComplete()) {
        showStatus('Please enter a complete 8-digit UF ID', 'error');
        showUfidError();
        return;
    }

    try {
        if (actionBtn) {
            actionBtn.disabled = true;
            actionBtn.classList.add('loading');
        }

        let result;
        console.log('Action click - Current mode:', currentMode);

        if (currentMode === 'signout') {
            console.log('Attempting sign OUT for:', ufid);
            result = await window.electronAPI.signOut({ ufid, name: '' });

            if (result.success) {
                showStatus(`Goodbye, ${result.studentName}! You've signed out successfully.`, 'success');
                clearUfid();
            } else {
                showStatus(result.message || 'Sign out failed', 'error');
                if (result.unauthorized) {
                    showUfidError();
                }
            }
        } else {
            console.log('Attempting sign IN for:', ufid);
            result = await window.electronAPI.signIn({ ufid, name: '' });

            if (result.success) {
                showStatus(`Welcome, ${result.studentName}! You've signed in successfully.`, 'success');
                clearUfid();
            } else {
                showStatus(result.message || 'Sign in failed', 'error');
                if (result.unauthorized) {
                    showUfidError();
                }
            }
        }
    } catch (error) {
        console.error('Action error:', error);
        showStatus('Error: ' + error.message, 'error');
        showUfidError();
    } finally {
        if (actionBtn) {
            actionBtn.disabled = false;
            actionBtn.classList.remove('loading');
        }
        validateUfid();
    }
}

// ==================== STATUS MESSAGE ====================

function showStatus(message, type) {
    if (!statusMessage) return;

    const icon = type === 'success'
        ? '<i class="fas fa-check-circle"></i>'
        : '<i class="fas fa-exclamation-circle"></i>';

    statusMessage.innerHTML = `${icon} ${message}`;
    statusMessage.className = `status ${type} show`;

    // Auto-hide after 5 seconds
    setTimeout(() => {
        statusMessage.classList.remove('show');
        setTimeout(() => {
            statusMessage.className = 'status';
        }, 300);
    }, 5000);
}

// ==================== ADMIN MODAL ====================

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

    if (closeBtn) closeBtn.addEventListener('click', closeAdminModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeAdminModal);
    if (loginBtn) loginBtn.addEventListener('click', verifyAdminPassword);

    // Handle Enter key
    if (passwordInput) {
        passwordInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                verifyAdminPassword();
            }
        });
    }

    // Close modal when clicking outside
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeAdminModal();
        }
    });

    // Focus on password input
    setTimeout(() => {
        if (passwordInput) passwordInput.focus();
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
    const loginBtn = document.getElementById('adminLoginBtn');
    const password = passwordInput ? passwordInput.value.trim() : '';

    if (!password) {
        showAdminError('Please enter a password');
        return;
    }

    try {
        if (loginBtn) {
            loginBtn.disabled = true;
            loginBtn.textContent = 'Verifying...';
        }

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
        if (loginBtn) {
            loginBtn.disabled = false;
            loginBtn.textContent = 'Login';
        }
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
