import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type PaymentStatus = "failed" | "retry_initiated" | "recovered";

export interface Payment {
  payment_id: string;
  amount_inr: number;
  due_date: string;
  status: PaymentStatus;
  failure_code: string;
  failure_reason: string;
  attempts: number;
}

export interface Customer {
  customer_id: string;
  name: string;
  phone: string;
  preferred_language: string;
  merchant: string;
  plan: string;
  mandate_type: string;
  mandate_status: string;
  payment: Payment;
  disputed: boolean;
  dispute_note?: string;
}

const DATA_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "customers.json");

let customers = new Map<string, Customer>();

export function resetCustomers(): void {
  const list = JSON.parse(readFileSync(DATA_FILE, "utf8")) as Customer[];
  customers = new Map(list.map((c) => [c.customer_id, c]));
}
resetCustomers();

export function getCustomer(id: string): Customer | undefined {
  return customers.get(id.trim().toUpperCase());
}

export function listCustomers(): Customer[] {
  return [...customers.values()];
}

export function maskPhone(phone: string): string {
  return phone.slice(0, 3) + "*".repeat(Math.max(phone.length - 7, 0)) + phone.slice(-4);
}

/** Public view of a customer: phone masked, safe to read out to the agent. */
export function publicCustomer(c: Customer) {
  const { phone, payment, ...rest } = c;
  return { ...rest, phone: maskPhone(phone), payment_status: payment.status, amount_inr: payment.amount_inr };
}
