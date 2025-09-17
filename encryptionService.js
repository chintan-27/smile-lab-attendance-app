const CryptoJS = require('crypto-js');
const fs = require('fs');
const path = require('path');

class EncryptionService {
    constructor(dataManager) {
        this.dataManager = dataManager;
        this.algorithm = 'AES';
    }

    // Generate encryption key from password
    generateKey(password, salt = 'UF_LAB_SALT_2024') {
        return CryptoJS.PBKDF2(password, salt, {
            keySize: 256/32,
            iterations: 10000
        });
    }

    // Encrypt data
    encrypt(data, password) {
        try {
            const key = this.generateKey(password);
            const encrypted = CryptoJS.AES.encrypt(JSON.stringify(data), key.toString()).toString();
            return { success: true, data: encrypted };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Decrypt data
    decrypt(encryptedData, password) {
        try {
            const key = this.generateKey(password);
            const bytes = CryptoJS.AES.decrypt(encryptedData, key.toString());
            const decrypted = bytes.toString(CryptoJS.enc.Utf8);
            return { success: true, data: JSON.parse(decrypted) };
        } catch (error) {
            return { success: false, error: 'Invalid password or corrupted data' };
        }
    }

    // Encrypt file
    encryptFile(filePath, password) {
        try {
            const data = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(data);
            const encrypted = this.encrypt(parsed, password);
            
            if (encrypted.success) {
                const encryptedFilePath = filePath + '.encrypted';
                fs.writeFileSync(encryptedFilePath, encrypted.data);
                return { success: true, encryptedPath: encryptedFilePath };
            } else {
                return encrypted;
            }
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Decrypt file
    decryptFile(encryptedFilePath, password, outputPath = null) {
        try {
            const encryptedData = fs.readFileSync(encryptedFilePath, 'utf8');
            const decrypted = this.decrypt(encryptedData, password);
            
            if (decrypted.success) {
                const output = outputPath || encryptedFilePath.replace('.encrypted', '');
                fs.writeFileSync(output, JSON.stringify(decrypted.data, null, 2));
                return { success: true, decryptedPath: output };
            } else {
                return decrypted;
            }
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Encrypt sensitive fields in data
    encryptSensitiveData(data, password, sensitiveFields = ['email', 'name']) {
        try {
            if (Array.isArray(data)) {
                return data.map(item => {
                    const encrypted = { ...item };
                    sensitiveFields.forEach(field => {
                        if (encrypted[field]) {
                            const encryptResult = this.encrypt(encrypted[field], password);
                            if (encryptResult.success) {
                                encrypted[field] = encryptResult.data;
                                encrypted[field + '_encrypted'] = true;
                            }
                        }
                    });
                    return encrypted;
                });
            } else {
                const encrypted = { ...data };
                sensitiveFields.forEach(field => {
                    if (encrypted[field]) {
                        const encryptResult = this.encrypt(encrypted[field], password);
                        if (encryptResult.success) {
                            encrypted[field] = encryptResult.data;
                            encrypted[field + '_encrypted'] = true;
                        }
                    }
                });
                return encrypted;
            }
        } catch (error) {
            console.error('Encryption error:', error);
            return data;
        }
    }

    // Decrypt sensitive fields in data
    decryptSensitiveData(data, password, sensitiveFields = ['email', 'name']) {
        try {
            if (Array.isArray(data)) {
                return data.map(item => {
                    const decrypted = { ...item };
                    sensitiveFields.forEach(field => {
                        if (decrypted[field] && decrypted[field + '_encrypted']) {
                            const decryptResult = this.decrypt(decrypted[field], password);
                            if (decryptResult.success) {
                                decrypted[field] = decryptResult.data;
                                delete decrypted[field + '_encrypted'];
                            }
                        }
                    });
                    return decrypted;
                });
            } else {
                const decrypted = { ...data };
                sensitiveFields.forEach(field => {
                    if (decrypted[field] && decrypted[field + '_encrypted']) {
                        const decryptResult = this.decrypt(decrypted[field], password);
                        if (decryptResult.success) {
                            decrypted[field] = decryptResult.data;
                            delete decrypted[field + '_encrypted'];
                        }
                    }
                });
                return decrypted;
            }
        } catch (error) {
            console.error('Decryption error:', error);
            return data;
        }
    }

    // Hash password for storage
    hashPassword(password) {
        return CryptoJS.SHA256(password).toString();
    }

    // Verify password hash
    verifyPassword(password, hash) {
        return this.hashPassword(password) === hash;
    }

    // Generate secure random key
    generateSecureKey(length = 32) {
        const array = new Uint8Array(length);
        require('crypto').getRandomValues(array);
        return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
    }

    // Check if data is encrypted
    isEncrypted(data) {
        if (typeof data === 'string') {
            try {
                // Try to parse as JSON first
                JSON.parse(data);
                return false;
            } catch {
                // If it's not valid JSON, it might be encrypted
                return data.length > 0 && !data.includes('{') && !data.includes('[');
            }
        }
        return false;
    }

    // Secure delete (overwrite file multiple times)
    secureDelete(filePath, passes = 3) {
        try {
            if (!fs.existsSync(filePath)) {
                return { success: false, error: 'File not found' };
            }

            const fileSize = fs.statSync(filePath).size;
            const randomData = require('crypto').randomBytes(fileSize);

            // Overwrite file multiple times
            for (let i = 0; i < passes; i++) {
                fs.writeFileSync(filePath, randomData);
            }

            // Finally delete the file
            fs.unlinkSync(filePath);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}

module.exports = EncryptionService;