import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const password = await bcrypt.hash("mumBai#64", 10);

  const acme = await prisma.tenant.upsert({
    where: {
      slug: "acme",
    },
    update: {},
    create: {
      slug: "acme",
      name: "Acme Corporation",
    },
  });

  const globex = await prisma.tenant.upsert({
    where: {
      slug: "globex",
    },
    update: {},
    create: {
      slug: "globex",
      name: "Globex Corporation",
    },
  });

  await prisma.user.upsert({
    where: {
      email: "admin@acme.com",
    },
    update: {},
    create: {
      email: "admin@acme.com",
      password,
      role: "ADMIN",
      tenantId: acme.id,
    },
  });

  await prisma.user.upsert({
    where: {
      email: "member@acme.com",
    },
    update: {},
    create: {
      email: "member@acme.com",
      password,
      role: "MEMBER",
      tenantId: acme.id,
    },
  });

  await prisma.user.upsert({
    where: {
      email: "admin@globex.com",
    },
    update: {},
    create: {
      email: "admin@globex.com",
      password,
      role: "ADMIN",
      tenantId: globex.id,
    },
  });

  await prisma.user.upsert({
    where: {
      email: "member@globex.com",
    },
    update: {},
    create: {
      email: "member@globex.com",
      password,
      role: "MEMBER",
      tenantId: globex.id,
    },
  });

  console.log("✅ Seed completed successfully");
}

main()
  .catch((error) => {
    console.error("❌ Seed failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
