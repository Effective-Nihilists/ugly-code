---
name: create-test-users
description: Create test users and seed data
user-invocable: true
---

# Creating Test Users

## Register a test user
```bash
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test1@test.com","password":"testpass123"}'
# Returns: {"token":"..."}
```

## Save token for use in tests
```bash
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test1@test.com","password":"testpass123"}' | jq -r .token)
echo $TOKEN
```

## Seed multiple users
```bash
for i in 1 2 3 4 5; do
  curl -s -X POST http://localhost:3000/auth/register \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"bot${i}@test.com\",\"password\":\"botpass123\"}"
done
```

## Delete all test users
```bash
mongosh "$MONGODB_URI" --eval "db.user.deleteMany({email:/test\.com$/})"
```

# Notes
<!-- Claude: append observations here — record which test users exist -->
