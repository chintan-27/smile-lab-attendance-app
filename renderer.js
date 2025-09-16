// Enhanced renderer.js with OTP-style UFID input and full functionality
function showStatus(message, isSuccess = true) {
    const statusDiv = document.getElementById('status');
    statusDiv.textContent = message;
    statusDiv.className = `status ${isSuccess ? 'success' : 'error'}`;
    statusDiv.style.display = 'block';
    
    setTimeout(() => {
        statusDiv.style.display = 'none';
    }, 4000);
}

// UFID handling functions
function getUFID() {
    const inputs = document.querySelectorAll('.ufid-input');
    let ufid = '';
    inputs.forEach(input => {
        ufid += input.value;
    });
    return ufid;
}

function clearUFID() {
    const inputs = document.querySelectorAll('.ufid-input');
    inputs.forEach(input => {
        input.value = '';
        input.classList.remove('valid', 'invalid');
    });
    resetButtons();
    hideNameInput();
    updateUFIDStatus('');
    
    // Focus first input
    const firstInput = document.querySelector('.ufid-input');
    if (firstInput) {
        firstInput.focus();
    }
}

function resetButtons() {
    document.getElementById('signInBtn').disabled = true;
    document.getElementById('signOutBtn').disabled = true;
}

function enableButtons() {
    document.getElementById('signInBtn').disabled = false;
    document.getElementById('signOutBtn').disabled = false;
}

function showNameInput() {
    const nameInput = document.getElementById('nameInput');
    nameInput.classList.add('show');
    setTimeout(() => {
        nameInput.focus();
    }, 100);
}

function hideNameInput() {
    const nameInput = document.getElementById('nameInput');
    nameInput.classList.remove('show');
    nameInput.value = '';
}

function updateUFIDStatus(message, isValid = null) {
    const statusDiv = document.getElementById('ufidStatus');
    statusDiv.textContent = message;
    statusDiv.className = `ufid-status ${isValid === true ? 'valid' : isValid === false ? 'invalid' : ''}`;
}

// Validate UFID and check student status
let checkTimeout;
async function validateAndCheckUFID() {
    const ufid = getUFID();
    
    if (ufid.length !== 8) {
        resetButtons();
        hideNameInput();
        if (ufid.length > 0) {
            updateUFIDStatus(`Enter ${8 - ufid.length} more digit${8 - ufid.length !== 1 ? 's' : ''}`, false);
        } else {
            updateUFIDStatus('');
        }
        return;
    }

    // UFID is complete, check if student exists
    clearTimeout(checkTimeout);
    checkTimeout = setTimeout(async () => {
        try {
            const result = await window.electronAPI.getStudentStatus(ufid);
            
            if (result.authorized) {
                const statusText = result.status === 'signin' ? 'Currently signed in' : 
                                 result.status === 'signout' ? 'Ready to sign in' : 
                                 'Ready to sign in';
                updateUFIDStatus(`✅ ${result.name} - ${statusText}`, true);
                enableButtons();
                hideNameInput();
                
                // Update input styling
                const inputs = document.querySelectorAll('.ufid-input');
                inputs.forEach(input => {
                    input.classList.remove('invalid');
                    input.classList.add('valid');
                });
            } else {
                updateUFIDStatus('❌ Student not found. Please enter your name below.', false);
                resetButtons();
                showNameInput();
                
                // Update input styling
                const inputs = document.querySelectorAll('.ufid-input');
                inputs.forEach(input => {
                    input.classList.remove('valid');
                    input.classList.add('invalid');
                });
            }
        } catch (error) {
            console.error('Error checking student:', error);
            updateUFIDStatus('Error checking student status', false);
            resetButtons();
        }
    }, 300);
}

async function handleSignIn() {
    const ufid = getUFID();
    const name = document.getElementById('nameInput').value.trim();
    
    if (ufid.length !== 8) {
        showStatus('Please enter a complete 8-digit UF ID', false);
        return;
    }
    
    // Check if we need a name (for new students)
    const nameInput = document.getElementById('nameInput');
    if (nameInput.classList.contains('show') && !name) {
        showStatus('Please enter your full name', false);
        nameInput.focus();
        return;
    }
    
    try {
        const result = await window.electronAPI.signIn({ ufid, name });
        
        if (result.success) {
            showStatus(result.message, true);
            clearUFID();
            
            // If it was a new student, add them to the system
            if (name && nameInput.classList.contains('show')) {
                await window.electronAPI.addStudent({ ufid, name, email: '' });
            }
        } else {
            if (result.unauthorized && name) {
                // Try to add the student first
                const addResult = await window.electronAPI.addStudent({ ufid, name, email: '' });
                if (addResult.success) {
                    // Now try signing in again
                    const signInResult = await window.electronAPI.signIn({ ufid, name });
                    if (signInResult.success) {
                        showStatus(`Welcome ${name}! You've been added to the system and signed in.`, true);
                        clearUFID();
                    } else {
                        showStatus('❌ ' + signInResult.message, false);
                    }
                } else {
                    showStatus('❌ Could not add student to system', false);
                }
            } else {
                if (result.unauthorized) {
                    showStatus('❌ ' + result.message, false);
                } else if (result.duplicate || result.noSignIn) {
                    showStatus('⚠️ ' + result.message, false);
                } else {
                    showStatus('❌ ' + result.message, false);
                }
            }
        }
    } catch (error) {
        console.error('Sign in error:', error);
        showStatus('❌ Error during sign in', false);
    }
}

async function handleSignOut() {
    const ufid = getUFID();
    const name = document.getElementById('nameInput').value.trim();
    
    if (ufid.length !== 8) {
        showStatus('Please enter a complete 8-digit UF ID', false);
        return;
    }
    
    try {
        const result = await window.electronAPI.signOut({ ufid, name });
        
        if (result.success) {
            showStatus(result.message, true);
            clearUFID();
        } else {
            if (result.unauthorized) {
                showStatus('❌ ' + result.message, false);
            } else if (result.duplicate || result.noSignIn) {
                showStatus('⚠️ ' + result.message, false);
            } else {
                showStatus('❌ ' + result.message, false);
            }
        }
    } catch (error) {
        console.error('Sign out error:', error);
        showStatus('❌ Error during sign out', false);
    }
}

// Admin functions
function showAdminLogin() {
    const modal = document.getElementById('adminModal');
    if (modal) {
        modal.classList.add('show');
        const passwordInput = document.getElementById('adminPassword');
        if (passwordInput) {
            passwordInput.focus();
        }
    }
}

function hideAdminLogin() {
    const modal = document.getElementById('adminModal');
    if (modal) {
        modal.classList.remove('show');
        const passwordInput = document.getElementById('adminPassword');
        if (passwordInput) {
            passwordInput.value = '';
        }
    }
}

async function loginAdmin() {
    const passwordInput = document.getElementById('adminPassword');
    if (!passwordInput) {
        return;
    }
    
    const password = passwordInput.value;
    
    if (!password) {
        showStatus('Please enter admin password', false);
        return;
    }
    
    try {
        const isValid = await window.electronAPI.verifyAdmin(password);
        
        if (isValid) {
            window.location.href = 'admin.html';
        } else {
            showStatus('Invalid admin password', false);
        }
    } catch (error) {
        console.error('Admin login error:', error);
        showStatus('Error verifying password', false);
    }
    
    hideAdminLogin();
}

// Setup OTP-style input behavior
function setupUFIDInputs() {
    const inputs = document.querySelectorAll('.ufid-input');
    
    inputs.forEach((input, index) => {
        // Handle input
        input.addEventListener('input', function(e) {
            const value = e.target.value;
            
            // Only allow numbers
            if (!/^\d*$/.test(value)) {
                e.target.value = value.replace(/\D/g, '');
                return;
            }
            
            // Move to next input if current is filled
            if (value && index < inputs.length - 1) {
                inputs[index + 1].focus();
            }
            
            validateAndCheckUFID();
        });
        
        // Handle keydown events
        input.addEventListener('keydown', function(e) {
            // Handle backspace
            if (e.key === 'Backspace' && !e.target.value && index > 0) {
                inputs[index - 1].focus();
            }
            
            // Handle Enter key when all digits are entered
            if (e.key === 'Enter' && getUFID().length === 8) {
                handleSignIn();
            }
            
            // Handle arrow keys
            if (e.key === 'ArrowLeft' && index > 0) {
                inputs[index - 1].focus();
            }
            if (e.key === 'ArrowRight' && index < inputs.length - 1) {
                inputs[index + 1].focus();
            }
        });
        
        // Handle paste
        input.addEventListener('paste', function(e) {
            e.preventDefault();
            const paste = (e.clipboardData || window.clipboardData).getData('text');
            const numbers = paste.replace(/\D/g, '').slice(0, 8);
            
            if (numbers.length > 0) {
                // Clear all inputs first
                inputs.forEach(inp => inp.value = '');
                
                // Fill inputs with pasted numbers
                for (let i = 0; i < numbers.length && i < inputs.length; i++) {
                    inputs[i].value = numbers[i];
                }
                
                // Focus on the next empty input or the last one
                const nextIndex = Math.min(numbers.length, inputs.length - 1);
                inputs[nextIndex].focus();
                
                validateAndCheckUFID();
            }
        });
        
        // Select all on focus
        input.addEventListener('focus', function() {
            this.select();
        });
        
        // Prevent non-numeric input on keypress
        input.addEventListener('keypress', function(e) {
            if (!/\d/.test(e.key) && !['Backspace', 'Delete', 'Tab', 'Enter', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
                e.preventDefault();
            }
        });
    });
}

// Handle name input for new students
function setupNameInput() {
    const nameInput = document.getElementById('nameInput');
    if (nameInput) {
        nameInput.addEventListener('input', function() {
            const name = this.value.trim();
            const ufid = getUFID();
            
            if (name && ufid.length === 8) {
                enableButtons();
            } else if (ufid.length === 8) {
                // If name is required but empty, disable buttons
                const nameInputVisible = this.classList.contains('show');
                if (nameInputVisible && !name) {
                    resetButtons();
                }
            }
        });
        
        nameInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                handleSignIn();
            }
        });
    }
}

// Event listeners setup
document.addEventListener('DOMContentLoaded', function() {
    console.log('DOM loaded - setting up attendance system');
    
    // Setup UFID inputs
    setupUFIDInputs();
    
    // Setup name input
    setupNameInput();
    
    // Focus first input
    const firstInput = document.querySelector('.ufid-input');
    if (firstInput) {
        firstInput.focus();
    }

    // Clear button
    const clearBtn = document.getElementById('clearBtn');
    if (clearBtn) {
        clearBtn.addEventListener('click', clearUFID);
    }

    // Sign in button
    const signInBtn = document.getElementById('signInBtn');
    if (signInBtn) {
        signInBtn.addEventListener('click', handleSignIn);
    }

    // Sign out button
    const signOutBtn = document.getElementById('signOutBtn');
    if (signOutBtn) {
        signOutBtn.addEventListener('click', handleSignOut);
    }

    // Admin button
    const adminBtn = document.getElementById('adminBtn');
    if (adminBtn) {
        adminBtn.addEventListener('click', showAdminLogin);
    }

    // Close modal button
    const closeModal = document.getElementById('closeModal');
    if (closeModal) {
        closeModal.addEventListener('click', hideAdminLogin);
    }

    // Login button in modal
    const loginBtn = document.getElementById('loginBtn');
    if (loginBtn) {
        loginBtn.addEventListener('click', loginAdmin);
    }
    
    // Admin password enter key
    const adminPasswordInput = document.getElementById('adminPassword');
    if (adminPasswordInput) {
        adminPasswordInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                loginAdmin();
            }
        });
    }

    // Close modal when clicking outside
    const adminModal = document.getElementById('adminModal');
    if (adminModal) {
        adminModal.addEventListener('click', function(e) {
            if (e.target === adminModal) {
                hideAdminLogin();
            }
        });
    }

    // Prevent form submission
    const attendanceForm = document.getElementById('attendanceForm');
    if (attendanceForm) {
        attendanceForm.addEventListener('submit', function(e) {
            e.preventDefault();
        });
    }
});

// Handle app focus to refocus on first input
window.addEventListener('focus', function() {
    const ufid = getUFID();
    if (ufid.length === 0) {
        const firstInput = document.querySelector('.ufid-input');
        if (firstInput) {
            setTimeout(() => firstInput.focus(), 100);
        }
    }
});

// Export functions for testing (if needed)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        getUFID,
        clearUFID,
        validateAndCheckUFID,
        handleSignIn,
        handleSignOut
    };
}