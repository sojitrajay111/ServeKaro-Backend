import mongoose from 'mongoose';

const { Schema } = mongoose;
export const { ObjectId } = Schema.Types;

const hiddenAlways = ['_id', '__v', 'restaurantId'];

function toJSON(hidden) {
  return {
    virtuals: false,
    transform(doc, ret) {
      if (ret._id) ret.id = String(ret._id);
      for (const k of [...hiddenAlways, ...hidden]) delete ret[k];
      return ret;
    },
  };
}

const QUERY_HOOKS = [
  'find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete', 'countDocuments',
  'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'replaceOne',
];

// Refuses any query on a tenant collection that isn't filtered by restaurantId.
// Escape hatch for the few cross-tenant lookups (login, public QR):
//   Model.findOne(filter).setOptions({ crossTenant: true })
function tenantGuard(schema) {
  for (const hook of QUERY_HOOKS) {
    schema.pre(hook, function () {
      if (this.getOptions().crossTenant) return;
      if (!this.getFilter().restaurantId) {
        throw new Error(`${this.model.modelName}.${hook} without restaurantId`);
      }
    });
  }
  schema.pre('aggregate', function () {
    if (this.options.crossTenant) return;
    const first = this.pipeline()[0];
    if (!first?.$match?.restaurantId) {
      throw new Error('aggregate must start with $match on restaurantId');
    }
  });
}

/**
 * Schema with timestamps, clean JSON output and, unless tenant: false,
 * a required restaurantId plus the tenant guard.
 */
export function makeSchema(definition, { tenant = true, hidden = [], ...options } = {}) {
  const def = tenant
    ? { restaurantId: { type: ObjectId, ref: 'Restaurant', required: true, index: true }, ...definition }
    : definition;
  const schema = new Schema(def, { timestamps: true, ...options, toJSON: toJSON(hidden) });
  if (tenant) tenantGuard(schema);
  return schema;
}

// Sub-documents keep their _id but expose it as id.
export function subSchema(definition) {
  return new Schema(definition, { toJSON: toJSON([]) });
}
