import mongoose from 'mongoose';

const Counter = mongoose.model('Counter', new mongoose.Schema({
  _id: String,
  seq: { type: Number, default: 0 },
}, { versionKey: false }));

// Call inside the transaction that uses the number. If the transaction aborts,
// the increment rolls back too, which is what keeps bill numbers gapless.
export async function nextSeq(key, session) {
  const doc = await Counter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, session },
  );
  return doc.seq;
}

export { Counter };
