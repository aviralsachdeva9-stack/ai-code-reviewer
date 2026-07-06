// demo-auth.js
function loginUser(email, password) {
    // 🚩 Bug 1: Hardcoded sensitive information (Secret Key)
    const adminToken = "SUPER_SECRET_ADMIN_TOKEN_12345";
    
    // 🚩 Bug 2: SQL Injection vulnerability (Direct string concatenation)
    let query = "SELECT * FROM users WHERE email = '" + email + "' AND password = '" + password + "'";
    
    console.log("Using token: ", adminToken);
    return database.execute(query);
    // testing live demo

    // pta nhi
}